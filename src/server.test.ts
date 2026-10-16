import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { startServer } from "./server.js";
import type { ServerHandle } from "./server.js";

const TOKEN = "good-token";
const HASH = "abc123";
const PUBLIC = "https://box.ts.net:8443";

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let fake: http.Server;
let fakePort: number;
let seen: Seen[] = [];
let handle: ServerHandle;
let base: string;

before(async () => {
  fake = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      const send = (status: number, value: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(typeof value === "string" ? value : JSON.stringify(value));
      };
      const url = req.url!;
      if (url === "/api/v1/reviews/r1/view" && req.method === "POST") return send(200, { url: `/bundles/${HASH}/view/index.html`, bundle: HASH, review: {} });
      if (url === "/api/v1/reviews/r1") return send(200, { id: "r1", status: "pending", plugin: "feedback", revises: "r0" });
      if (url === "/api/v1/reviews/r0") return send(200, { id: "r0", status: "decided" });
      if (url === "/api/v1/reviews/r1/decision") return send(200, { ok: true });
      if (url === "/api/v1/plugins") return send(200, { plugins: [{ name: "feedback", settings: { a: 1 } }, { name: "other", settings: { b: 2 } }] });
      if (url.startsWith("/bundles/")) {
        return send(200, "<html></html>", {
          "content-type": "text/html",
          "content-security-policy": `default-src 'self' http://${req.headers.host}; img-src data: https://cdn.example.com; connect-src http://127.0.0.1:9999`,
          "x-extra": "kept",
        });
      }
      send(200, "ok");
    });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  fakePort = (fake.address() as AddressInfo).port;
  handle = await startServer({ pinrail: `http://127.0.0.1:${fakePort}`, reviewId: "r1", token: TOKEN, publicOrigin: PUBLIC, pageHtml: "<p>__TOKEN__</p>" });
  base = `http://127.0.0.1:${handle.port}`;
});

after(async () => {
  await handle.close();
  await new Promise((r) => fake.close(r));
});

const decide = (body: unknown) =>
  fetch(`${base}/x/${TOKEN}/decision`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

describe("homing server", () => {
  test("learns the bundle hash from /view at startup", () => {
    assert.equal(handle.bundle, HASH);
  });

  test("a wrong token returns 404 on every /x/ route", async () => {
    const routes: [string, string][] = [
      ["GET", "review"],
      ["GET", "previous"],
      ["POST", "view"],
      ["GET", "settings"],
      ["GET", "attachments/a.png"],
      ["POST", "decision"],
    ];
    seen = [];
    for (const [method, rest] of routes) {
      const res = await fetch(`${base}/x/wrong/${rest}`, { method, body: method === "POST" ? "{}" : undefined });
      assert.equal(res.status, 404, `${method} ${rest}`);
    }
    assert.deepEqual(seen, [], "nothing reached Pinrail");
  });

  test("a wrong token on the share page returns 404", async () => {
    assert.equal((await fetch(`${base}/s/wrong`)).status, 404);
    const ok = await fetch(`${base}/s/${TOKEN}`);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), `<p>${TOKEN}</p>`);
  });

  test("a route not in the table returns 404", async () => {
    seen = [];
    for (const p of ["/", "/api/v1/reviews/r1", "/api/v1/info", "/x", `/x/${TOKEN}`, `/x/${TOKEN}/other`, "/preview/other.js", "/sdk/v1/../../api/v1/info"]) {
      const res = await fetch(`${base}${p}`);
      assert.equal(res.status, 404, p);
    }
    assert.deepEqual(seen, []);
  });

  test("a bundle hash that is not this review's returns 404", async () => {
    seen = [];
    assert.equal((await fetch(`${base}/bundles/other/view/index.html`)).status, 404);
    assert.equal((await fetch(`${base}/bundles/${HASH}/other/index.html`)).status, 404);
    assert.equal((await fetch(`${base}/bundles/${HASH}/view/../../x`)).status, 404);
    assert.deepEqual(seen, []);
    assert.equal((await fetch(`${base}/bundles/${HASH}/view/index.html`)).status, 200);
  });

  test("a method not in the table returns 405", async () => {
    assert.equal((await fetch(`${base}/x/${TOKEN}/review`, { method: "POST", body: "{}" })).status, 405);
    assert.equal((await fetch(`${base}/x/${TOKEN}/decision`)).status, 405);
  });

  test("the decision body sent upstream has by, bundle, and this review's id, whatever the page sends", async () => {
    seen = [];
    const res = await decide({
      data: { answer: 42 },
      name: "Ann",
      note: "looks good",
      by: "evil",
      bundle: "evil",
      id: "other",
      review_id: "other",
      dry_run: true,
    });
    assert.equal(res.status, 200);
    const up = seen.find((s) => s.url.endsWith("/decision"))!;
    assert.equal(up.url, "/api/v1/reviews/r1/decision");
    assert.deepEqual(JSON.parse(up.body), { data: { answer: 42 }, by: "Ann (via homing)", agent_note: "looks good", bundle: HASH });
  });
});

describe("upstream request headers", () => {
  test("sends Host 127.0.0.1:<port>, no Origin, and keeps Sec-Fetch-Dest", async () => {
    seen = [];
    await fetch(`${base}/bundles/${HASH}/view/index.html`, {
      headers: { origin: "https://evil.example", referer: "https://evil.example/", cookie: "a=b", authorization: "Bearer x", "sec-fetch-dest": "iframe" },
    });
    await fetch(`${base}/x/${TOKEN}/review`, { headers: { origin: "https://evil.example", cookie: "a=b" } });
    assert.equal(seen.length, 2);
    for (const s of seen) {
      assert.equal(s.headers.host, `127.0.0.1:${fakePort}`);
      assert.equal(s.headers.origin, undefined);
      assert.equal(s.headers.referer, undefined);
      assert.equal(s.headers.cookie, undefined);
      assert.equal(s.headers.authorization, undefined);
    }
    assert.equal(seen[0]!.headers["sec-fetch-dest"], "iframe");
  });

  test("POST upstream sends Content-Type application/json", async () => {
    seen = [];
    await fetch(`${base}/x/${TOKEN}/view`, { method: "POST", body: "{}" });
    assert.equal(seen[0]!.headers["content-type"], "application/json");
  });
});

describe("CSP rewrite", () => {
  test("replaces the loopback address and nothing else", async () => {
    const res = await fetch(`${base}/bundles/${HASH}/view/index.html`);
    assert.equal(
      res.headers.get("content-security-policy"),
      `default-src 'self' ${PUBLIC}; img-src data: https://cdn.example.com; connect-src http://127.0.0.1:9999`,
    );
    assert.equal(res.headers.get("x-extra"), "kept");
    assert.equal(res.headers.get("content-type"), "text/html");
    assert.equal(await res.text(), "<html></html>");
  });
});

describe("after the review is decided", () => {
  test("a decision returns 409 and does not reach Pinrail", async () => {
    handle.markDecided();
    seen = [];
    const res = await decide({ data: {}, name: "Bob" });
    assert.equal(res.status, 409);
    assert.deepEqual(seen, []);
  });
});
