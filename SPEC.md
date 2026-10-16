# Homing: share one Pinrail review with a teammate

## Goal

Build a small command-line helper called `homing`. It lets a teammate decide one Pinrail review from their own browser, while the agent waits.

The flow:

1. An agent submits a review to Pinrail with `--wait` and blocks.
2. Vulture runs `homing <review-id>`.
3. `homing` prints a public link. Vulture sends it to a teammate.
4. The teammate opens the link, sees the plugin's real review view, and hands over a decision.
5. Pinrail records the decision. The agent's `--wait` ends and the agent carries on.
6. `homing` shuts the public link off and exits.

This version is for live review only. The teammate decides while the agent still waits.

## Hard rules

- Do not change Pinrail. `homing` is a separate program that talks to the running Pinrail app over its local HTTP API.
- The Pinrail source is in `../pinrail` as a read-only reference. Read it. Do not edit it, build it, or import from it.
- Never expose Pinrail's own port to the network. Only expose `homing`'s own port.
- One run of `homing` shares exactly one review. Everything else is refused.

## Background: how Pinrail works

Read these files in `../pinrail` before you write code:

| File | Why |
| --- | --- |
| `desktop/core/src/api/mod.rs` | The HTTP API routes, CORS, and how the server starts. |
| `desktop/core/src/api/guard.rs` | Why Pinrail refuses any `Host` that is not loopback, and why writes must send `Content-Type: application/json`. |
| `desktop/core/src/api/files.rs` | How plugin view bundles and the SDK are served, and the CSP each bundle file gets. |
| `desktop/core/src/api/preview.html` | The browser review page. `homing`'s page is a copy of this page with a real hand-over. |
| `desktop/core/src/api/reviews.rs` | The review routes, the decision body, and `source()`, which reads `by` from the body. |
| `desktop/core/src/server_info.rs` | `server.json`, which says which port Pinrail runs on. |
| `sdk/host/host.js` | `connectFrame`, the app's side of the plugin protocol. Pinrail serves it at `/preview/host.js`. |
| `docs/agents/cli.md` | Where the data directory is, and the CLI's behaviour. |

Facts that matter:

- Pinrail listens on `http://127.0.0.1:4747` by default. The real port is in `<data dir>/server.json`. The data directory is `PINRAIL_DATA_DIR`, else `$XDG_DATA_HOME/pinrail`, else `~/.local/share/pinrail`. Read `server.json` first and fall back to 4747.
- Pinrail has no login. Any program on the machine can read and decide any review. That is why `homing` must filter every request.
- Pinrail refuses a request whose `Host` header is not `127.0.0.1`, `localhost`, or `[::1]`. `homing` must send `Host: 127.0.0.1:<port>` upstream.
- `POST /api/v1/reviews/{id}/decision` takes `{"data": ..., "by": "<name>", "agent_note": "<text>", "bundle": "<hash>"}`. Pinrail records `by` as `decided_by`. Do not send an `Origin` header upstream, or Pinrail can treat the request as the app.
- `POST /api/v1/reviews/{id}/view` returns `{"url": "/bundles/<hash>/view/index.html", "bundle": "<hash>", "review": {...}}`.
- Each bundle file's CSP names the address the browser used, built from the `Host` header as `http://<host>`. Because `homing` sends `Host: 127.0.0.1:<port>`, the CSP names `http://127.0.0.1:<port>`. The teammate's browser cannot load from that address. `homing` must rewrite that address in the CSP to the public origin, for example `https://<name>.ts.net:8443`.

## What to build

### Command

```
homing <review-id> [options]

Options:
  --tailnet          Use `tailscale serve` (tailnet only) instead of `tailscale funnel` (public).
  --https-port N     The public HTTPS port. Default 8443. Funnel allows 443, 8443, and 10000.
  --port N           The local port homing listens on. Default: a free port.
  --timeout M        Minutes before the link shuts off. Default 30.
  --pinrail URL      Pinrail's address. Default: from server.json, else http://127.0.0.1:4747.
```

Use port 8443 by default so `homing` does not replace a funnel already on 443.

### Startup

1. Find Pinrail's address. Call `GET /api/v1/info`. If it fails, print "Pinrail is not running" and exit 1.
2. Call `GET /api/v1/reviews/<id>`. If the review does not exist, print that and exit 1. If its `status` is not `pending`, print the status and exit 1.
3. Make a token: 32 random bytes, base64url.
4. Start the local HTTP server on `127.0.0.1` only.
5. Start Tailscale:
   - Public: `tailscale funnel --bg --https=<https-port> http://127.0.0.1:<port>`
   - Tailnet: `tailscale serve --bg --https=<https-port> http://127.0.0.1:<port>`
6. Find the public host from `tailscale status --json` (`Self.DNSName`, without the trailing dot).
7. Print the link `https://<host>:<https-port>/s/<token>` and copy it to the clipboard with `pbcopy` on macOS.

If `tailscale` is missing, or Funnel is not enabled for the tailnet, print the error from Tailscale and exit 1.

### Shutdown

Shut down when any of these happens:

- The review leaves `pending`. Poll `GET /api/v1/reviews/<id>` every 3 seconds.
- The timeout ends.
- Vulture presses Ctrl-C.

On shutdown, always:

1. Run `tailscale funnel --https=<https-port> off` (or `tailscale serve --https=<https-port> off`).
2. Close the local server.
3. Print how the review ended, and who decided it, if anyone.

Run step 1 on every exit path, including errors and signals.

### The local server: allowed routes

Refuse every route not in this table with 404. Refuse any method not listed with 405.

| Route | Method | Token | Forward to Pinrail |
| --- | --- | --- | --- |
| `/s/<token>` | GET | in path | No. Serve the share page. |
| `/preview/host.js` | GET | none | Yes, as is. |
| `/sdk/v1/*` | GET | none | Yes, as is. |
| `/bundles/<hash>/view/*` | GET | none | Yes, only if `<hash>` is this review's bundle hash. Rewrite the CSP. |
| `/x/<token>/review` | GET | in path | `GET /api/v1/reviews/<id>` |
| `/x/<token>/previous` | GET | in path | `GET /api/v1/reviews/<revises>`, only if the review has `revises` |
| `/x/<token>/view` | POST | in path | `POST /api/v1/reviews/<id>/view` |
| `/x/<token>/settings` | GET | in path | `GET /api/v1/plugins`, but return only `{settings}` for this review's plugin |
| `/x/<token>/attachments/<name>` | GET | in path | `GET /api/v1/reviews/<id>/attachments/<name>` |
| `/x/<token>/decision` | POST | in path | `POST /api/v1/reviews/<id>/decision` |

Rules for every forwarded request:

- Compare the token with a constant-time compare. A wrong token gets 404, not 401.
- Never take a review id from the request. Always use the id `homing` started with.
- Send `Host: 127.0.0.1:<pinrail-port>`. Drop `Origin`, `Referer`, `Cookie`, and `Authorization`.
- Keep `Sec-Fetch-Dest`. Pinrail uses it to refuse bundle files read with fetch.
- For POST, send `Content-Type: application/json`.
- Cap request bodies at 4 MB, the same limit Pinrail uses.
- For `/x/<token>/decision`, build the body yourself: `{"data": <from the page>, "by": "<name> (via homing)", "agent_note": <from the page or omitted>, "bundle": <this review's bundle hash>}`. Ignore any other field the page sends.
- After the review leaves `pending`, refuse `/x/<token>/decision` with 409.
- Log each request to the terminal as one line: method, path with the token replaced by `***`, status.

The bundle hash comes from the `bundle` field of the `/view` response. Call `/view` once at startup to learn it.

### CSP rewrite for bundle files

For `/bundles/<hash>/view/*` responses, replace every `http://127.0.0.1:<pinrail-port>` in the `Content-Security-Policy` header with `https://<public-host>:<https-port>`. Leave every other header as Pinrail sent it.

Test this early. If the plugin view loads blank in the teammate's browser, this rewrite is the first place to look.

### The share page

Copy `../pinrail/desktop/core/src/api/preview.html` to `homing/page.html`. Keep the Apache-2.0 notice from Pinrail in a comment at the top. Then change it:

1. `homing` injects the token into the page when it serves it, for example as `const TOKEN = "...";`. Do not read the review id from the address.
2. Change every API call to the `/x/<token>/...` routes in the table above.
3. Add a "Your name" text input above the hand-over button. It is required. Save it in `localStorage` and fill it in on the next visit.
4. Add an optional "Note to the agent" text area. Send it as `agent_note`.
5. Change the hand-over to a real decision. Send `{data, name, note}` to `/x/<token>/decision` without `dry_run`.
   - On success, show "Decision sent. You can close this page." and make the page read-only.
   - On a 422 or a schema error, pass the violations back to the view, the same way `preview.html` does.
6. Change the button text from "Check the hand-over" to "Send decision".
7. Remove the "Decide it in Pinrail" link. The teammate does not have Pinrail.
8. Serve the page with the same CSP `preview.html` gets in `files.rs`, plus `frame-src 'self'`.
9. Add `<meta name="referrer" content="no-referrer">` so the token does not leak in a `Referer` header.

Keep the rest of `preview.html` as is: the theme handling, `connectFrame`, file loading, the previous round, and the Cmd/Ctrl+Enter shortcut.

## Stack

- TypeScript on Node 22 or newer.
- Use `node:http`, `node:crypto`, and `node:child_process`. Use the global `fetch` for upstream calls. Add no web framework.
- One package with a `bin` entry, so `npm link` installs `homing`.
- Tests with `node:test`.

## Tests

Write automated tests for the parts that do not need Tailscale. Run the local server against a fake Pinrail in the tests.

- A wrong token returns 404 on every `/x/` route.
- A route not in the table returns 404.
- A bundle hash that is not this review's returns 404.
- The decision body sent upstream has `by`, `bundle`, and this review's id, even if the page sends other values.
- The upstream request has `Host: 127.0.0.1:<port>` and no `Origin`.
- The CSP rewrite replaces the loopback address and nothing else.
- A decision after the review is decided returns 409.
- Shutdown runs the `tailscale ... off` command on Ctrl-C and on an error. Mock `child_process` for this test.

## Manual test with the real app

Run this on the Mac with Pinrail running and Tailscale signed in:

1. In terminal 1: `pinrail submit feedback --sample --wait`. Note the review id it prints on stderr.
2. In terminal 2: `homing <id>`.
3. Open the printed link on a phone that is off Wi-Fi, so it goes through Funnel.
4. Check that the feedback view loads with its questions.
5. Answer, enter a name, and press "Send decision".
6. Check that terminal 1 prints the decision, shows the name as the decider, and exits with code 0.
7. Check that `homing` exits and that `tailscale funnel status` no longer lists port 8443.

Repeat steps 1 to 7 with `markdown`, `canvas`, and `image` samples. `canvas` and `image` use attachments, so they test the attachment route and the CSP rewrite.

## Done when

- All automated tests pass.
- The manual test passes for `feedback`, `markdown`, `canvas`, and `image`.
- The README explains install, usage, the security rules above, and how to switch to `--tailnet`.
- No file in `../pinrail` changed.

## Out of scope

- Delayed review, when the agent session is closed before the teammate decides.
- More than one teammate on the same review.
- Sharing more than one review in one run.
- Windows.
- A menubar button. A later version can call `homing` from Updraft.
