import { writeFileSync, renameSync } from "node:fs";

export const DAEMON_SHUTDOWN_TIMEOUT_MS = 10_000;
export const DAEMON_STOP_WAIT_MS = DAEMON_SHUTDOWN_TIMEOUT_MS + 2_000;
export const DAEMON_HTTP_CONNECTION_GRACE_MS = 250;
export const DAEMON_SHUTDOWN_RECEIPT = "daemon-shutdown.json";
export interface DaemonShutdownReceipt {
  schema: "openrig.daemon-shutdown/v1";
  pid: number;
  startedAt: string;
  completedAt: string;
  outcome: "clean" | "failed" | "timed-out";
  phase: string;
  failures: Array<{ phase: string; error: string }>;
}

interface ServerShutdownHandle {
  close(callback: (error?: Error) => void): unknown;
  closeIdleConnections?: () => void;
  closeAllConnections?: () => void;
}

/** Stop accepting requests, drain idle keep-alive sockets, then end remaining
 * active HTTP streams (for example SSE clients) before completing shutdown. */
export function closeHttpServer(server: ServerShutdownHandle, graceMs = DAEMON_HTTP_CONNECTION_GRACE_MS): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const forceCloseTimer = setTimeout(() => server.closeAllConnections?.(), graceMs);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(forceCloseTimer);
      if (error) reject(error);
      else resolve();
    };
    try {
      server.close(finish);
      server.closeIdleConnections?.();
    } catch (error) {
      finish(error as Error);
    }
  });
}

/** One budget for the existing sequential cleanup, including its first await.
 * ponytail: this bounds asynchronous shutdown only; a synchronous event-loop
 * wedge still needs identity-checked operator recovery, not another supervisor. */
export function createDaemonShutdown(options: {
  phases: Array<[string, () => unknown]>;
  markClean: () => void;
  receiptPath: string;
  timeoutMs?: number;
  exit?: (code: number) => void;
  log?: (message: string) => void;
}): (signal: string) => void {
  let started = false;
  return (signal) => {
    if (started) return;
    started = true;
    let finished = false;
    let phase = "starting";
    const startedAt = new Date().toISOString();
    const failures: DaemonShutdownReceipt["failures"] = [];
    const timeoutMs = options.timeoutMs ?? DAEMON_SHUTDOWN_TIMEOUT_MS;
    const log = options.log ?? console.error;
    const exit = options.exit ?? ((code) => process.exit(code));
    const fail = (error: unknown) => {
      failures.push({ phase, error: String(error) });
      log(`[shutdown] ${phase} failed: ${String(error)}`);
    };
    const finish = (outcome: DaemonShutdownReceipt["outcome"]) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      let code = outcome === "clean" ? 0 : 1;
      const receipt: DaemonShutdownReceipt = {
        schema: "openrig.daemon-shutdown/v1", pid: process.pid, startedAt,
        completedAt: new Date().toISOString(), outcome,
        phase: outcome === "clean" ? "complete" : phase, failures,
      };
      try {
        const temp = `${options.receiptPath}.${process.pid}.tmp`;
        writeFileSync(temp, JSON.stringify(receipt) + "\n");
        renameSync(temp, options.receiptPath);
      } catch (error) {
        log(`[shutdown] outcome receipt unavailable: ${String(error)}`);
        code = 1;
      }
      log(`[shutdown] ${outcome}; phase=${receipt.phase}; budget=${timeoutMs}ms; exit=${code}`);
      exit(code);
    };
    // Referenced deliberately: this must also enforce the bound with no servers.
    const timer = setTimeout(() => {
      fail(`whole-shutdown budget exhausted (${timeoutMs}ms); pending effects are unverified`);
      finish("timed-out");
    }, timeoutMs);
    log(`OpenRig daemon received ${signal}; shutting down (budget ${timeoutMs}ms)`);
    void (async () => {
      for (const [name, run] of options.phases) {
        if (finished) return;
        phase = name;
        try { await run(); } catch (error) { if (!finished) fail(error); }
      }
      if (finished) return;
      if (failures.length === 0) {
        phase = "lifecycle-stop";
        try { options.markClean(); } catch (error) { fail(error); }
      }
      if (failures.length) phase = failures[0]!.phase;
      finish(failures.length ? "failed" : "clean");
    })();
  };
}
