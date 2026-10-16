import cp from "node:child_process";

export type Mode = "funnel" | "serve";

/** Runs `tailscale` and resolves with stdout. Rejects with Tailscale's own message. */
export function tailscale(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    const child = cp.execFile("tailscale", args, (err, stdout, stderr) => {
      done = true;
      clearTimeout(timer);
      if (!err) return resolve(String(stdout));
      const text = String(stderr || stdout || "").trim() || (err as Error).message;
      reject(new Error(timedOut ? `tailscale ${args[0]} timed out after 15s: ${text}` : text));
    });
    // Kept to the 3-argument execFile call shape that the tests mock.
    if (!done) {
      timer = setTimeout(() => {
        timedOut = true;
        child?.kill?.();
      }, 15_000);
    }
  });
}

/** Publishes the local port on the HTTPS port and returns the public host name. */
export async function start(mode: Mode, httpsPort: number, localPort: number): Promise<string> {
  await tailscale([mode, "--bg", `--https=${httpsPort}`, `http://127.0.0.1:${localPort}`]);
  const status = JSON.parse(await tailscale(["status", "--json"]));
  const name: unknown = status?.Self?.DNSName;
  if (typeof name !== "string" || !name) throw new Error("tailscale status has no Self.DNSName");
  return name.replace(/\.$/, "");
}

/** Turns the public link off. */
export async function stop(mode: Mode, httpsPort: number): Promise<void> {
  await tailscale([mode, `--https=${httpsPort}`, "off"]);
}
