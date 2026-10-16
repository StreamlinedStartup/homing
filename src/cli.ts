import cp from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { startServer } from "./server.js";
import type { ServerHandle } from "./server.js";
import * as ts from "./tailscale.js";

const USAGE = `homing <review-id> [options]

Options:
  --tailnet          Use \`tailscale serve\` (tailnet only) instead of \`tailscale funnel\` (public).
  --https-port N     The public HTTPS port. Default 8443. Funnel allows 443, 8443, and 10000.
  --port N           The local port homing listens on. Default: a free port.
  --timeout M        Minutes before the link shuts off. Default 30.
  --pinrail URL      Pinrail's address. Default: from server.json, else http://127.0.0.1:4747.`;

export interface Options {
  reviewId: string;
  mode: ts.Mode;
  httpsPort: number;
  port: number;
  timeoutMin: number;
  pinrail?: string;
}

/** Everything a test may replace. */
export interface Io {
  /** Where SIGINT and SIGTERM arrive. Default: process. */
  signals?: EventEmitter;
  /** One line of output. Default: stdout. */
  out?: (line: string) => void;
  /** Milliseconds between status polls. Default 3000. */
  pollMs?: number;
  env?: NodeJS.ProcessEnv;
}

export function parseCli(argv: string[]): Options {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      tailnet: { type: "boolean" },
      "https-port": { type: "string" },
      port: { type: "string" },
      timeout: { type: "string" },
      pinrail: { type: "string" },
    },
  });
  const num = (name: string, v: string | undefined, def: number) => {
    if (v === undefined) return def;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} needs a whole number`);
    return n;
  };
  const [reviewId, ...extra] = positionals;
  if (!reviewId || extra.length) throw new Error(USAGE);
  const timeoutMin = num("timeout", values.timeout, 30);
  if (timeoutMin * 60_000 > 2 ** 31 - 1) throw new Error("--timeout is too large (35791 minutes at most)");
  return {
    reviewId,
    mode: values.tailnet ? "serve" : "funnel",
    httpsPort: num("https-port", values["https-port"], 8443),
    port: num("port", values.port, 0),
    timeoutMin,
    pinrail: values.pinrail,
  };
}

/** Pinrail's address: server.json in the data directory, else the default port. */
export function findPinrail(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.PINRAIL_DATA_DIR || join(env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "pinrail");
  try {
    const info = JSON.parse(readFileSync(join(dir, "server.json"), "utf8"));
    if (typeof info.url === "string") return info.url;
    if (Number.isInteger(info.port)) return `http://127.0.0.1:${info.port}`;
  } catch {
    // no server.json: use the default
  }
  return "http://127.0.0.1:4747";
}

class Fail extends Error {}

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

/** Runs one share. Resolves with the exit code. Always runs `tailscale ... off` once it has started Tailscale. */
export async function main(argv: string[], io: Io = {}): Promise<number> {
  const out = io.out ?? ((line: string) => void process.stdout.write(line + "\n"));
  const signals: EventEmitter = io.signals ?? process;
  let opts: Options;
  try {
    opts = parseCli(argv);
  } catch (err) {
    out((err as Error).message);
    return 1;
  }

  const pinrail = opts.pinrail ?? findPinrail(io.env);
  const id = encodeURIComponent(opts.reviewId);
  const getReview = async () => fetch(new URL(`/api/v1/reviews/${id}`, pinrail));

  let server: ServerHandle | undefined;
  let tailscaleStarted = false;
  let review: any;
  let stopPolling = () => {};
  const onSignal = () => end("interrupted");
  let end: (why: string) => void = () => {};
  const ended = new Promise<string>((resolve) => (end = resolve));
  let isEnded = false;
  void ended.then(() => (isEnded = true));
  let starting: Promise<string> | undefined;
  let code = 0;

  let fatal = false;
  const onFatal = (err: unknown) => {
    if (fatal) return;
    fatal = true;
    out(`Error: ${(err as Error)?.message ?? err}`);
    const stopped = tailscaleStarted ? ts.stop(opts.mode, opts.httpsPort).catch(() => {}) : Promise.resolve();
    void stopped.finally(() => process.exit(1));
  };
  for (const sig of SIGNALS) signals.on(sig, onSignal);
  process.on("uncaughtException", onFatal);
  process.on("unhandledRejection", onFatal);
  try {
    const info = await fetch(new URL("/api/v1/info", pinrail)).catch(() => null);
    if (!info?.ok) throw new Fail("Pinrail is not running");
    const found = await getReview();
    if (found.status === 404) throw new Fail(`Review ${opts.reviewId} does not exist`);
    if (!found.ok) throw new Fail(`Pinrail answered ${found.status} for review ${opts.reviewId}`);
    review = await found.json();
    if (review.status !== "pending") throw new Fail(`Review ${opts.reviewId} is ${review.status}, not pending`);

    const token = randomBytes(32).toString("base64url");
    server = await startServer({ pinrail, reviewId: opts.reviewId, token, port: opts.port, log: out });

    if (isEnded) throw new Fail("Stopped before the link was ready.");
    tailscaleStarted = true;
    starting = ts.start(opts.mode, opts.httpsPort, server.port);
    const started = await Promise.race([starting.then((h) => ({ h })), ended.then(() => null)]);
    if (!started) throw new Fail("Stopped before the link was ready.");
    const host = started.h;
    server.setPublicOrigin(`https://${host}:${opts.httpsPort}`);
    const link = `https://${host}:${opts.httpsPort}/s/${token}`;
    out(`Link: ${link}`);
    if (process.platform === "darwin") cp.execFile("pbcopy", [], () => {})?.stdin?.end(link);

    const timer = setTimeout(() => end("timed out"), opts.timeoutMin * 60_000);
    let busy = false;
    const poller = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const r = await getReview();
        const body: any = await r.json();
        if (body.status && body.status !== "pending") {
          review = body;
          server?.markDecided();
          end(body.status);
        }
      } catch {
        // Pinrail may be briefly unreachable; the next poll tries again.
      }
      busy = false;
    }, io.pollMs ?? 3000);
    stopPolling = () => (clearTimeout(timer), clearInterval(poller));

    out(`Waiting for a decision on ${opts.reviewId}. Press Ctrl-C to stop.`);
    const why = await ended;
    if (why === "interrupted" || why === "timed out") out(`Stopping: ${why}.`);
  } catch (err) {
    out(err instanceof Fail ? err.message : `Error: ${(err as Error).message}`);
    code = 1;
  } finally {
    stopPolling();
    if (tailscaleStarted) {
      await starting?.catch(() => {});
      try {
        await ts.stop(opts.mode, opts.httpsPort);
      } catch (err) {
        out(`Could not turn the link off: ${(err as Error).message}`);
        code = 1;
      }
    }
    await server?.close();
    // Signal handlers stay until Tailscale is off, so a late Ctrl-C cannot kill the process early.
    for (const sig of SIGNALS) signals.off(sig, onSignal);
    process.off("uncaughtException", onFatal);
    process.off("unhandledRejection", onFatal);
  }

  if (review && tailscaleStarted) {
    const last = await getReview().then((r) => r.json()).catch(() => review);
    const status = last?.status ?? review.status;
    out(status === "pending" ? "The review is still pending." : `The review is ${status}${last?.decided_by ? `, decided by ${last.decided_by}` : ""}.`);
  }
  return code;
}
