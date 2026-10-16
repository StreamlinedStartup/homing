import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

const MAX_BODY = 4 * 1024 * 1024;
const PAGE_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; frame-src 'self'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";
const DROP_RESPONSE = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"]);

export interface ServerOptions {
  /** Pinrail's base URL, for example http://127.0.0.1:4747. */
  pinrail: string;
  reviewId: string;
  token: string;
  /** For example https://name.ts.net:8443. Can be set later with setPublicOrigin. */
  publicOrigin?: string;
  /** Local port. 0 picks a free one. */
  port?: number;
  /** Receives one line per request. */
  log?: (line: string) => void;
  /** Overrides the page template (it holds "__TOKEN__"). */
  pageHtml?: string;
}

export interface ServerHandle {
  port: number;
  bundle: string;
  setPublicOrigin(origin: string): void;
  /** Makes /x/<token>/decision answer 409. */
  markDecided(): void;
  close(): Promise<void>;
}

interface Upstream {
  status: number;
  headers: Headers;
  body: Buffer;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const sameToken = (a: string, b: string) =>
  timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Splits a path tail into decoded segments and refuses anything that could climb out of it. */
function safeSegments(tail: string): string[] | null {
  if (!tail) return null;
  const out: string[] = [];
  for (const raw of tail.split("/")) {
    let seg: string;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (!seg || seg === "." || seg === ".." || /[/\\\0]/.test(seg)) return null;
    out.push(seg);
  }
  return out;
}

const enc = (segs: string[]) => segs.map(encodeURIComponent).join("/");

export async function startServer(opts: ServerOptions): Promise<ServerHandle> {
  const pinrail = new URL(opts.pinrail);
  const upstreamHost = `127.0.0.1:${pinrail.port || "80"}`;
  const id = encodeURIComponent(opts.reviewId);
  const log = opts.log ?? (() => {});
  const template = opts.pageHtml ?? readFileSync(new URL("../page.html", import.meta.url), "utf8");
  let publicOrigin = opts.publicOrigin ?? "";
  let decided = false;
  let bundle = "";

  async function up(path: string, init: { method?: string; body?: string; fetchDest?: string | undefined } = {}): Promise<Upstream> {
    const headers: Record<string, string> = { host: upstreamHost };
    if (init.fetchDest) headers["sec-fetch-dest"] = init.fetchDest;
    if (init.method === "POST") headers["content-type"] = "application/json";
    const res = await fetch(new URL(path, pinrail), { method: init.method ?? "GET", headers, body: init.body });
    return { status: res.status, headers: res.headers, body: Buffer.from(await res.arrayBuffer()) };
  }

  const json = (u: Upstream): any => {
    try {
      return JSON.parse(u.body.toString("utf8"));
    } catch {
      return null;
    }
  };

  function send(res: ServerResponse, status: number, body: Buffer | string, headers: Record<string, string | string[]> = {}) {
    const buf = typeof body === "string" ? Buffer.from(body) : body;
    res.writeHead(status, { ...headers, "content-length": buf.length });
    res.end(buf);
  }
  const sendJson = (res: ServerResponse, status: number, value: unknown) =>
    send(res, status, JSON.stringify(value), { "content-type": "application/json" });

  function relay(res: ServerResponse, u: Upstream, rewriteCsp = false) {
    const headers: Record<string, string | string[]> = {};
    u.headers.forEach((value, key) => {
      if (DROP_RESPONSE.has(key)) return;
      headers[key] = rewriteCsp && key === "content-security-policy" ? value.split(`http://${upstreamHost}`).join(publicOrigin) : value;
    });
    send(res, u.status, u.body, headers);
  }

  async function handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<number> {
    const method = req.method ?? "GET";
    const reply = (status: number, text = "") => (send(res, status, text), status);
    const fetchDest = req.headers["sec-fetch-dest"] as string | undefined;
    const relayed = (u: Upstream, rewrite = false) => (relay(res, u, rewrite), u.status);

    // Public routes and the share page.
    if (path.startsWith("/s/")) {
      const token = path.slice(3);
      if (!sameToken(token, opts.token)) return reply(404);
      if (method !== "GET") return reply(405);
      const html = template.replace("__TOKEN__", opts.token);
      send(res, 200, html, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": PAGE_CSP,
        "cache-control": "no-cache",
        "referrer-policy": "no-referrer",
      });
      return 200;
    }
    if (path === "/preview/host.js" || path.startsWith("/sdk/v1/")) {
      if (method !== "GET") return reply(405);
      if (path !== "/preview/host.js" && !safeSegments(path.slice("/sdk/v1/".length))) return reply(404);
      return relayed(await up(path, { fetchDest }));
    }
    if (path.startsWith("/bundles/")) {
      const segs = safeSegments(path.slice("/bundles/".length));
      if (!segs || segs.length < 3 || segs[0] !== bundle || segs[1] !== "view") return reply(404);
      if (method !== "GET") return reply(405);
      return relayed(await up(`/bundles/${enc(segs)}`, { fetchDest }), true);
    }

    // Token routes.
    const m = /^\/x\/([^/]+)\/(.*)$/.exec(path);
    if (!m || !sameToken(m[1]!, opts.token)) return reply(404);
    const rest = m[2]!;
    const allow = (want: string) => method === want;

    if (rest === "review") {
      if (!allow("GET")) return reply(405);
      return relayed(await up(`/api/v1/reviews/${id}`, { fetchDest }));
    }
    if (rest === "previous") {
      if (!allow("GET")) return reply(405);
      const review = json(await up(`/api/v1/reviews/${id}`, { fetchDest }));
      if (!review?.revises) return reply(404);
      return relayed(await up(`/api/v1/reviews/${encodeURIComponent(String(review.revises))}`, { fetchDest }));
    }
    if (rest === "view") {
      if (!allow("POST")) return reply(405);
      await readBody(req);
      return relayed(await up(`/api/v1/reviews/${id}/view`, { method: "POST", fetchDest }));
    }
    if (rest === "settings") {
      if (!allow("GET")) return reply(405);
      const review = json(await up(`/api/v1/reviews/${id}`, { fetchDest }));
      const plugins = await up("/api/v1/plugins", { fetchDest });
      if (!review || plugins.status !== 200) return reply(502);
      const found = ((json(plugins)?.plugins as any[]) ?? []).find((p) => p?.name === review.plugin);
      sendJson(res, 200, { settings: found?.settings ?? {} });
      return 200;
    }
    if (rest.startsWith("attachments/")) {
      if (!allow("GET")) return reply(405);
      const segs = safeSegments(rest.slice("attachments/".length));
      if (!segs || segs.length !== 1) return reply(404);
      return relayed(await up(`/api/v1/reviews/${id}/attachments/${enc(segs)}`, { fetchDest }));
    }
    if (rest === "decision") {
      if (!allow("POST")) return reply(405);
      const raw = await readBody(req);
      if (decided) {
        sendJson(res, 409, { message: "This review is no longer pending." });
        return 409;
      }
      let page: any;
      try {
        page = JSON.parse(raw.toString("utf8"));
      } catch {
        page = null;
      }
      const name = typeof page?.name === "string" ? page.name.trim().slice(0, 80) : "";
      if (!name) {
        sendJson(res, 400, { message: "Your name is required." });
        return 400;
      }
      const body: Record<string, unknown> = { data: page.data, by: `${name} (via homing)` };
      if (typeof page.note === "string" && page.note.trim()) body.agent_note = page.note;
      body.bundle = bundle;
      const u = await up(`/api/v1/reviews/${id}/decision`, { method: "POST", body: JSON.stringify(body), fetchDest });
      if (u.status >= 200 && u.status < 300) decided = true;
      return relayed(u);
    }
    return reply(404);
  }

  const server = http.createServer((req, res) => {
    const raw = req.url ?? "/";
    let path: string;
    try {
      if (!raw.startsWith("/")) throw new Error("not origin-form");
      path = new URL("http://local" + raw).pathname;
    } catch {
      send(res, 400, "");
      log(`${req.method} (bad url) 400`);
      return;
    }
    const shown = path.replace(/^\/(s|x)\/[^/]+/, "/$1/***");
    handle(req, res, path)
      .catch((err) => {
        const status = err instanceof HttpError ? err.status : 502;
        if (!res.headersSent) send(res, status, "");
        return status;
      })
      .then((status) => log(`${req.method} ${shown} ${status}`));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", resolve);
  });

  const handleOut: ServerHandle = {
    port: (server.address() as AddressInfo).port,
    get bundle() {
      return bundle;
    },
    setPublicOrigin: (origin) => void (publicOrigin = origin),
    markDecided: () => void (decided = true),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };

  try {
    const view = await up(`/api/v1/reviews/${id}/view`, { method: "POST" });
    const hash = json(view)?.bundle;
    if (view.status !== 200 || typeof hash !== "string" || !hash) throw new Error(`Pinrail refused to open the review view (${view.status}).`);
    bundle = hash;
  } catch (err) {
    await handleOut.close();
    throw err;
  }
  return handleOut;
}
