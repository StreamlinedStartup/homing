# homing

Share one Pinrail review with a teammate. The teammate decides it from their own browser while the agent's `--wait` blocks.

## Install

Requires Node 22 or newer and Tailscale (signed in; Funnel enabled for public links).

```
pnpm install
pnpm build
npm link
```

## Use

```
pinrail submit feedback --sample --wait     # terminal 1, note the review id
homing <review-id>                          # terminal 2
```

`homing` prints a link like `https://<host>.ts.net:8443/s/<token>` and copies it to the clipboard (`pbcopy`). Send it to the teammate. They see the plugin's review view, enter a name and an optional note, and press "Send decision". Pinrail records the decision as `<name> (via homing)`, the agent carries on, and `homing` turns the link off and exits.

Options:

| Option | Meaning |
| --- | --- |
| `--tailnet` | Use `tailscale serve` (tailnet only) instead of `tailscale funnel` (public). |
| `--https-port N` | Public HTTPS port. Default 8443. Funnel allows 443, 8443, and 10000. |
| `--port N` | Local port. Default: a free port. |
| `--timeout M` | Minutes before the link shuts off. Default 30. |
| `--pinrail URL` | Pinrail's address. Default: from `server.json`, else `http://127.0.0.1:4747`. |

### Tailnet only

Run `homing <review-id> --tailnet`. Only devices on your tailnet can open the link.

## Security rules

- `homing` is a separate program. It talks to the running Pinrail app over its local HTTP API and does not change Pinrail.
- Pinrail's own port is never exposed. Only `homing`'s port, bound to `127.0.0.1`, is published through Tailscale.
- One run shares one review. The review id is fixed at startup and never read from a request.
- Only the routes in `SPEC.md` are served. Other routes return 404 and other methods return 405.
- The link holds a 32-byte random token, compared in constant time. A wrong token returns 404.
- Upstream requests send `Host: 127.0.0.1:<pinrail-port>` and drop `Origin`, `Referer`, `Cookie`, and `Authorization`.
- Bundle files are served only for this review's bundle hash. Their CSP is rewritten to the public origin.
- The decision body is built by `homing` from the page's `data`, name, and note. The bundle hash and review id are set by `homing`.
- Request bodies are capped at 4 MB. Logs replace the token with `***`.
- After the review leaves `pending`, decisions return 409.
- The link is turned off on every exit path: decision, timeout, Ctrl-C, SIGTERM, SIGHUP, and errors.

## Tests

```
npm test
```

The tests run the real server against a fake Pinrail and mock `child_process` for the Tailscale commands. The manual test with a phone and Funnel is in `SPEC.md`.
