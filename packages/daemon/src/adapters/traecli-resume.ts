import { operationalLaunchArg } from "./kernel-authority.js";
import { setTimeout as sleep } from "node:timers/promises";
import nodePath from "node:path";
import os from "node:os";
import type { TmuxAdapter } from "./tmux.js";
import type { SeatLaunchEnvironment } from "../domain/seat-launch-environment.js";
import type { ResumeResult } from "./claude-resume.js";
import { assessNativeResumeProbe } from "../domain/native-resume-probe.js";
import { shellQuote } from "./shell-quote.js";
import { traecliPostureArg } from "./yolo-mode.js";
import { observeCodexSandbox } from "../domain/permission-drift.js";

const TRAECLI_TYPES = new Set(["traecli_id", "traecli_last"]);
const SHELL_COMMANDS = new Set(["bash", "fish", "nu", "sh", "tmux", "zsh"]);

export { type ResumeResult };

interface TraecliResumeOptions {
  seatLaunchEnvironment?: SeatLaunchEnvironment;
  launchPath?: string;
  traecliHome?: string;
  pollMs?: number;
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  exec?: (cmd: string) => Promise<string>;
}

export class TraecliResumeAdapter {
  constructor(
    private tmux: TmuxAdapter,
    private options: TraecliResumeOptions = {}
  ) {}

  canResume(resumeType: string | null, resumeToken: string | null): boolean {
    if (!resumeType || !TRAECLI_TYPES.has(resumeType)) return false;
    if (resumeType === "traecli_last") return true;
    if (!resumeToken) return false;
    return true;
  }

  async resume(
    tmuxSessionName: string,
    resumeType: string | null,
    resumeToken: string | null,
    cwd: string,
    resolvedPosture?: "floor" | "full_bypass" | "auto",
    model?: string | null,
    effort?: string | null,
    nonInterruptive?: boolean,
    kernelAuthority?: boolean,
    teamPermissionDefault?: boolean,
  ): Promise<ResumeResult> {
    if (!this.canResume(resumeType, resumeToken)) {
      return { ok: false, code: "no_resume", message: "TraeCLI resume not available" };
    }

    const posture = traecliPostureArg(process.env, resolvedPosture);
    const appliedLaunch = observeCodexSandbox(posture);
    const postureArg = posture + operationalLaunchArg("traecli", { kernelAuthority, teamPermissionDefault, nonInterruptive, launchPosture: resolvedPosture });
    const daemonArg = "--no-daemon";
    const altScreenArg = "--no-alt-screen";
    const cwdArg = `-C ${shellQuote(cwd)}`;
    const modelArg = model ? ` -m ${shellQuote(model)}` : "";
    const tokenArg = resumeType === "traecli_last" ? "--last" : shellQuote(resumeToken ?? "");
    const cmd = `traecli ${daemonArg}${postureArg}${modelArg} ${altScreenArg} --resume ${tokenArg} ${cwdArg}`;

    const traeHome = this.options.traecliHome ?? process.env.TRAE_HOME?.trim() ?? nodePath.join(os.homedir(), ".trae");
    const launchEnv = [
      this.options.launchPath ? `PATH=${shellQuote(this.options.launchPath)}` : "",
      `TRAE_HOME=${shellQuote(traeHome)}`,
    ].filter(Boolean);
    const textResult = await this.tmux.sendShellCommand(tmuxSessionName, this.options.seatLaunchEnvironment
      ? await this.options.seatLaunchEnvironment.command(tmuxSessionName, cmd, { runtime: "traecli" })
      : launchEnv.length ? `env ${launchEnv.join(" ")} ${cmd}` : cmd);
    if (!textResult.ok) {
      return { ok: false, code: "resume_failed", message: textResult.message };
    }

    const result = await this.verifyResume(tmuxSessionName);
    return result.ok ? { ...result, appliedLaunch } : result;
  }

  private async verifyResume(tmuxSessionName: string): Promise<ResumeResult> {
    const pollMs = this.options.pollMs ?? 200;
    const maxWaitMs = this.options.maxWaitMs ?? 5_000;
    const sleepFn = this.options.sleep ?? sleep;
    const attempts = Math.max(1, Math.floor(maxWaitMs / Math.max(pollMs, 1)) + 1);

    for (let attempt = 0; attempt < attempts; attempt++) {
      const paneCommand = await this.tmux.getPaneCommand(tmuxSessionName);
      const paneContent = (await this.tmux.capturePaneContent(tmuxSessionName, 40)) ?? "";
      const probe = assessNativeResumeProbe({
        runtime: "traecli",
        paneCommand,
        paneContent,
      });

      if (probe.code === "no_saved_session") {
        return {
          ok: false,
          code: "retry_fresh",
          message: "TraeCLI resume failed: no saved session found for the requested token",
        };
      }

      if (probe.status === "attention_required") {
        return {
          ok: false,
          code: "attention_required",
          message: probe.detail,
          evidence: paneContent.split("\n").slice(-12).join("\n"),
        };
      }

      if (probe.status === "resumed") {
        return { ok: true };
      }

      if (attempt < attempts - 1) {
        await sleepFn(pollMs);
      }
    }

    const finalCommand = await this.tmux.getPaneCommand(tmuxSessionName);
    const finalContent = (await this.tmux.capturePaneContent(tmuxSessionName, 40)) ?? "";
    const finalProbe = assessNativeResumeProbe({
      runtime: "traecli",
      paneCommand: finalCommand,
      paneContent: finalContent,
    });

    if (finalProbe.code === "no_saved_session") {
      return {
        ok: false,
        code: "retry_fresh",
        message: "TraeCLI resume failed: no saved session found for the requested token",
      };
    }

    if (finalProbe.status === "attention_required") {
      return {
        ok: false,
        code: "attention_required",
        message: finalProbe.detail,
        evidence: finalContent.split("\n").slice(-12).join("\n"),
      };
    }

    if (finalProbe.status === "resumed") {
      return { ok: true };
    }

    if (finalCommand && SHELL_COMMANDS.has(finalCommand)) {
      return {
        ok: false,
        code: "retry_fresh",
        message: "TraeCLI resume failed: pane returned to shell instead of entering TraeCLI",
      };
    }

    return {
      ok: false,
      code: "resume_failed",
      message: "TraeCLI resume failed: timed out waiting for TraeCLI to become active",
    };
  }
}
