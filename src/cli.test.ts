import assert from "node:assert/strict";
import cp from "node:child_process";
import { EventEmitter } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { main } from "./cli.js";

let fake: http.Server;
let pinrail: string;

beforeEach(async () => {
  fake = http.createServer((req, res) => {
    req.resume();
    const send = (value: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.url === "/api/v1/info") return send({ version: "x" });
    if (req.url === "/api/v1/reviews/r1") return send({ id: "r1", status: "pending", plugin: "feedback" });
    if (req.url === "/api/v1/reviews/r1/view") return send({ url: "/bundles/h/view/index.html", bundle: "h", review: {} });
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  pinrail = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
});

afterEach(async () => {
  mock.restoreAll();
  fake.closeAllConnections();
  await new Promise((r) => fake.close(r));
});

/** Replaces child_process.execFile. `failStatus` makes `tailscale status --json` fail. */
function mockTailscale(failStatus = false) {
  const calls: string[][] = [];
  mock.method(cp, "execFile", ((file: string, args: string[], cb: (...a: unknown[]) => void) => {
    if (file !== "tailscale") return { stdin: { end() {} } };
    calls.push(args);
    if (args[0] === "status") {
      if (failStatus) cb(new Error("boom"), "", "tailscale is logged out");
      else cb(null, JSON.stringify({ Self: { DNSName: "box.ts.net." } }), "");
    } else cb(null, "", "");
    return {};
  }) as unknown as typeof cp.execFile);
  return calls;
}

const waitFor = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(cond(), "timed out waiting");
};

describe("shutdown", () => {
  test("Ctrl-C runs `tailscale funnel --https=8443 off`", async () => {
    const calls = mockTailscale();
    const signals = new EventEmitter();
    const lines: string[] = [];
    const done = main(["r1", "--pinrail", pinrail], { signals, out: (l) => lines.push(l), pollMs: 50 });
    await waitFor(() => lines.some((l) => l.startsWith("Waiting")));
    assert.deepEqual(calls[0], ["funnel", "--bg", "--https=8443", calls[0]![3]]);
    assert.ok(lines.some((l) => l.startsWith("Link: https://box.ts.net:8443/s/")));
    signals.emit("SIGINT");
    assert.equal(await done, 0);
    assert.deepEqual(calls.at(-1), ["funnel", "--https=8443", "off"]);
  });

  test("--tailnet uses `tailscale serve ... off`", async () => {
    const calls = mockTailscale();
    const signals = new EventEmitter();
    const lines: string[] = [];
    const done = main(["r1", "--tailnet", "--https-port", "10000", "--pinrail", pinrail], { signals, out: (l) => lines.push(l), pollMs: 50 });
    await waitFor(() => lines.some((l) => l.startsWith("Waiting")));
    signals.emit("SIGTERM");
    await done;
    assert.deepEqual(calls.at(-1), ["serve", "--https=10000", "off"]);
  });

  test("an error after Tailscale started still runs `off`", async () => {
    const calls = mockTailscale(true);
    const lines: string[] = [];
    const code = await main(["r1", "--pinrail", pinrail], { signals: new EventEmitter(), out: (l) => lines.push(l), pollMs: 50 });
    assert.equal(code, 1);
    assert.ok(lines.some((l) => l.includes("tailscale is logged out")));
    assert.deepEqual(calls.at(-1), ["funnel", "--https=8443", "off"]);
  });

  test("no tailscale command runs when Pinrail is not running", async () => {
    const calls = mockTailscale();
    const lines: string[] = [];
    const code = await main(["r1", "--pinrail", "http://127.0.0.1:1"], { signals: new EventEmitter(), out: (l) => lines.push(l) });
    assert.equal(code, 1);
    assert.ok(lines.includes("Pinrail is not running"));
    assert.deepEqual(calls, []);
  });
});
