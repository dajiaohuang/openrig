import fs from "node:fs";
import { createServer, get as httpGet } from "node:http";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { closeHttpServer, createDaemonShutdown, DAEMON_SHUTDOWN_TIMEOUT_MS } from "../src/daemon-shutdown.js";

const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const p of dirs.splice(0)) fs.rmSync(p, { recursive: true, force: true }); });
function fixture(phases: Array<[string, () => unknown]>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shutdown-unit-")); dirs.push(dir);
  const receiptPath = path.join(dir, "result.json");
  const markClean = vi.fn(); const exit = vi.fn(); const log = vi.fn();
  const shutdown = createDaemonShutdown({ phases, markClean, exit, log, receiptPath });
  return { shutdown, exit, markClean, log, receipt: () => JSON.parse(fs.readFileSync(receiptPath, "utf8")) };
}
it("closes active event streams after a short grace period", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write("data: connected\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected an ephemeral TCP address");

  let responseClosed: Promise<unknown> | undefined;
  const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
    const request = httpGet(`http://127.0.0.1:${address.port}/events`);
    request.once("error", reject);
    request.once("response", (response) => {
      response.on("error", () => {});
      responseClosed = new Promise<void>((resolve) => response.once("close", resolve));
      resolve(response);
    });
  });

  await closeHttpServer(server, 20);
  await responseClosed;
  expect(response.complete).toBe(false);
  expect(server.listening).toBe(false);
});

it("writes clean lifecycle evidence only after every phase has drained", async () => {
  vi.useFakeTimers(); let release!: () => void;
  const f = fixture([["connections", () => new Promise<void>(r => { release = r; })], ["recorder", () => {}]]);
  f.shutdown("SIGTERM"); await Promise.resolve();
  expect(f.markClean).not.toHaveBeenCalled(); expect(f.exit).not.toHaveBeenCalled();
  release(); await vi.runAllTimersAsync();
  expect(f.markClean).toHaveBeenCalledOnce(); expect(f.exit).toHaveBeenCalledWith(0);
  expect(f.receipt()).toMatchObject({ outcome: "clean", phase: "complete", failures: [] });
});
it.each(["health-diagnosis", "watchdog", "wake-ladder", "connections", "recorder"])("bounds an unresolved %s phase from the first await", async (phase) => {
  vi.useFakeTimers(); const f = fixture([[phase, () => new Promise(() => {})]]);
  f.shutdown("SIGTERM"); await vi.advanceTimersByTimeAsync(DAEMON_SHUTDOWN_TIMEOUT_MS - 1);
  expect(f.exit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(f.exit).toHaveBeenCalledExactlyOnceWith(1); expect(f.markClean).not.toHaveBeenCalled();
  expect(f.receipt()).toMatchObject({ outcome: "timed-out", phase });
});
it.each([undefined, null, new Error("service failed")])("records even falsey rejections and still attempts subsequent drains: %s", async (error) => {
  vi.useFakeTimers(); const drain = vi.fn();
  const f = fixture([["watchdog", () => Promise.reject(error)], ["recorder", drain]]);
  f.shutdown("SIGTERM"); await vi.runAllTimersAsync();
  expect(drain).toHaveBeenCalledOnce(); expect(f.exit).toHaveBeenCalledWith(1);
  expect(f.markClean).not.toHaveBeenCalled();
  expect(f.receipt()).toMatchObject({ outcome: "failed", phase: "watchdog" });
});
it("repeat signals and late completion cannot write conflicting cleanup or clean evidence", async () => {
  vi.useFakeTimers(); let release!: () => void;
  const late = vi.fn(); const first = vi.fn(() => new Promise<void>(r => { release = r; }));
  const f = fixture([["watchdog", first], ["recorder", late]]);
  f.shutdown("SIGTERM"); f.shutdown("SIGINT"); f.shutdown("SIGTERM");
  await vi.runAllTimersAsync(); release(); await Promise.resolve(); await Promise.resolve();
  expect(first).toHaveBeenCalledOnce(); expect(late).not.toHaveBeenCalled();
  expect(f.exit).toHaveBeenCalledExactlyOnceWith(1); expect(f.markClean).not.toHaveBeenCalled();
  expect(f.receipt().outcome).toBe("timed-out");
});
it("a lifecycle stop-write failure cannot yield a clean receipt", async () => {
  vi.useFakeTimers(); const f = fixture([]);
  f.markClean.mockImplementation(() => { throw new Error("DB write failed"); });
  f.shutdown("SIGTERM"); await vi.runAllTimersAsync();
  expect(f.exit).toHaveBeenCalledWith(1);
  expect(f.receipt()).toMatchObject({ outcome: "failed", phase: "lifecycle-stop" });
});

it("enforces the whole-shutdown deadline with no other referenced handles", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shutdown-process-")); dirs.push(dir);
  const receiptPath = path.join(dir, "receipt.json");
  const moduleUrl = pathToFileURL(path.resolve(import.meta.dirname, "../src/daemon-shutdown.ts")).href;
  const source = `
    import { createDaemonShutdown } from ${JSON.stringify(moduleUrl)};
    createDaemonShutdown({
      phases: [["health-diagnosis", () => new Promise(() => {})]], timeoutMs: 150,
      markClean: () => { throw new Error("must not mark clean"); },
      receiptPath: ${JSON.stringify(receiptPath)},
    })("SIGTERM");
  `;
  const result = await promisify(execFile)(process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", source], {
      timeout: 5000,
      env: { PATH: process.env.PATH, HOME: dir, OPENRIG_HOME: dir, OPENRIG_DB: path.join(dir, "unused.sqlite"),
        CODEX_HOME: dir, CLAUDE_CONFIG_DIR: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir, XDG_DATA_HOME: dir },
    }).catch(error => error);
  expect(result.code).toBe(1);
  expect(JSON.parse(fs.readFileSync(receiptPath, "utf8"))).toMatchObject({ outcome: "timed-out", phase: "health-diagnosis" });
}, 7000);
