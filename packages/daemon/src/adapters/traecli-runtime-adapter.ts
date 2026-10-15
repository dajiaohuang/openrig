import { operationalLaunchArg } from "./kernel-authority.js";
import nodePath from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import { parse as parseToml } from "smol-toml";
import type { TmuxAdapter } from "./tmux.js";
import type { SeatLaunchEnvironment } from "../domain/seat-launch-environment.js";
import { traecliPostureArg } from "./yolo-mode.js";
import type {
  RuntimeAdapter, NodeBinding, ResolvedStartupFile,
  InstalledResource, ProjectionResult, StartupDeliveryResult, ReadinessResult,
  HarnessLaunchResult,
} from "../domain/runtime-adapter.js";
import { resolveConcreteHint } from "../domain/runtime-adapter.js";
import type { ProjectionPlan, ProjectionEntry } from "../domain/projection-planner.js";
import { observeCodexSandbox } from "../domain/permission-drift.js";
import { mergeManagedBlock } from "../domain/managed-blocks.js";
import { excludeNewGeneratedFiles } from "../domain/generated-file-hygiene.js";
import { shellQuote } from "./shell-quote.js";

export interface TraecliAdapterFsOps {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  exists(path: string): boolean;
  mkdirp(path: string): void;
  listFiles?(dirPath: string): string[];
  statMode?(path: string): number;
  chmod?(path: string, mode: number): void;
  homedir?: string;
}

export class TraecliRuntimeAdapter implements RuntimeAdapter {
  readonly runtime = "traecli";
  private tmux: TmuxAdapter;
  private seatLaunchEnvironment?: SeatLaunchEnvironment;
  private fs: TraecliAdapterFsOps;
  private sleep: (ms: number) => Promise<void>;
  private traeHome?: string;
  private launchPath?: string;
  private activityRelayPath?: string;

  constructor(deps: {
    tmux: TmuxAdapter;
    seatLaunchEnvironment?: SeatLaunchEnvironment;
    fsOps: TraecliAdapterFsOps;
    sleep?: (ms: number) => Promise<void>;
    activityRelayPath?: string;
    traeHome?: string;
    launchPath?: string;
  }) {
    this.tmux = deps.tmux;
    this.seatLaunchEnvironment = deps.seatLaunchEnvironment;
    this.fs = deps.fsOps;
    this.traeHome = deps.traeHome;
    this.launchPath = deps.launchPath;
    this.activityRelayPath = deps.activityRelayPath;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  ensureTraecliActivityHooks(): void {
    const relay = this.activityRelayPath;
    if (!relay || !this.fs.exists(relay)) {
      if (relay) {
        console.error(`[openrig] traecli activity hooks skipped: relay asset not found at ${relay}`);
      }
      return;
    }
    const configPath = this.resolveTraecliConfigPath();
    const existing = this.fs.exists(configPath) ? this.fs.readFile(configPath) : "";
    const withHooks = upsertTraecliActivityHooks(existing, relay);
    if (withHooks !== existing) {
      this.fs.mkdirp(nodePath.dirname(configPath));
      this.fs.writeFile(configPath, withHooks);
    }
    const trusted = this.applyTraecliActivityHookTrust(withHooks, configPath, relay);
    if (trusted !== withHooks) {
      this.fs.mkdirp(nodePath.dirname(configPath));
      this.fs.writeFile(configPath, trusted);
    }
  }

  private applyTraecliActivityHookTrust(content: string, configPath: string, relay: string): string {
    let keySource = configPath;
    try {
      keySource = fs.realpathSync.native(configPath);
    } catch {
    }
    const command = `node "${relay}"`;
    let next = content;
    for (const event of OPENRIG_ACTIVITY_HOOK_EVENTS) {
      const { key, hash } = computeTraecliHookTrust(event, { keySource, command, timeoutSec: 5 });
      next = upsertTraecliHookTrust(next, key, hash);
    }
    return next;
  }

  removeTraecliActivityHooks(): void {
    const configPath = this.resolveTraecliConfigPath();
    if (!this.fs.exists(configPath)) return;
    const existing = this.fs.readFile(configPath);
    const updated = stripTraecliActivityHooks(existing);
    if (updated !== existing) {
      this.fs.writeFile(configPath, updated);
    }
  }

  async listInstalled(binding: NodeBinding): Promise<InstalledResource[]> {
    const results: InstalledResource[] = [];
    const skillsDir = nodePath.join(binding.cwd, ".trae", "skills");
    if (this.fs.exists(skillsDir) && this.fs.listFiles) {
      for (const file of this.fs.listFiles(skillsDir)) {
        results.push({ effectiveId: file, category: "skill", installedPath: nodePath.join(skillsDir, file) });
      }
    }
    return results;
  }

  async project(plan: ProjectionPlan, binding: NodeBinding): Promise<ProjectionResult> {
    const projected: string[] = [];
    const warnings: string[] = [];
    const skipped: string[] = [];
    const failed: Array<{ effectiveId: string; error: string }> = [];

    for (const entry of plan.entries) {
      if (entry.classification === "no_op") {
        skipped.push(entry.effectiveId);
        continue;
      }

      try {
        const didProject = this.projectEntry(entry, binding.cwd, warnings);
        if (didProject) {
          projected.push(entry.effectiveId);
        } else {
          skipped.push(entry.effectiveId);
        }
      } catch (err) {
        failed.push({ effectiveId: entry.effectiveId, error: (err as Error).message });
      }
    }

    return { projected, skipped, failed, ...(warnings.length ? { warnings } : {}) };
  }

  async deliverStartup(files: ResolvedStartupFile[], binding: NodeBinding): Promise<StartupDeliveryResult> {
    try { this.ensureManagedBootstrap(binding); } catch (err) {
      console.error(`[openrig] traecli bootstrap warning: ${(err as Error).message}`);
    }

    const warnings: string[] = [];
    let delivered = 0;
    const failed: Array<{ path: string; error: string }> = [];

    for (const file of files) {
      try {
        const content = this.fs.readFile(file.absolutePath);
        const hint = file.deliveryHint === "auto" ? this.detectDeliveryHint(file.path, content) : file.deliveryHint;

        switch (hint) {
          case "guidance_merge": {
            const targetPath = nodePath.join(binding.cwd, "AGENTS.md");
            const merged = this.mergeGuidance(targetPath, file.path, content, warnings);
            if (!merged) continue;
            break;
          }
          case "skill_install": {
            const targetDir = nodePath.join(binding.cwd, ".trae", "skills", nodePath.basename(nodePath.dirname(file.absolutePath)));
            this.fs.mkdirp(targetDir);
            this.fs.writeFile(nodePath.join(targetDir, nodePath.basename(file.path)), content);
            break;
          }
          case "send_text": {
            if (binding.tmuxSession) {
              const textResult = await this.tmux.sendText(binding.tmuxSession, content);
              if (!textResult.ok) throw new Error(textResult.message);
              await this.sleep(200);
              const submitResult = await this.tmux.sendKeys(binding.tmuxSession, ["Enter"]);
              if (!submitResult.ok) throw new Error(submitResult.message);
            }
            break;
          }
        }
        delivered++;
      } catch (err) {
        if (file.required) {
          failed.push({ path: file.path, error: (err as Error).message });
        }
      }
    }

    return { delivered, failed, ...(warnings.length ? { warnings } : {}) };
  }

  async launchHarness(
    binding: NodeBinding,
    opts: { name: string; resumeToken?: string; forkSource?: import("../domain/runtime-adapter.js").ForkSource },
  ): Promise<HarnessLaunchResult> {
    if (!binding.tmuxSession) {
      return { ok: false, error: "No tmux session bound — cannot launch TraeCLI harness" };
    }

    if (opts.resumeToken && opts.forkSource) {
      return { ok: false, error: "resumeToken and forkSource are mutually exclusive — pick one" };
    }

    const model = binding.model?.trim();
    const modelArg = model ? ` -m ${shellQuote(model)}` : "";
    const posture = traecliPostureArg(process.env, binding.launchPosture);
    const appliedLaunch = observeCodexSandbox(posture);
    const postureArg = posture + operationalLaunchArg(this.runtime, binding);
    const daemonArg = " --no-daemon";
    const altScreenArg = " --no-alt-screen";

    const queueStateDirArg = this.buildQueueStateAddDirArg(opts.name);

    if (opts.forkSource) {
      if (opts.forkSource.kind !== "native_id") {
        return {
          ok: false,
          error: `traecli fork: ref.kind="${opts.forkSource.kind}" is not supported in v1; use ref.kind="native_id" with the prior conversation's session id`,
        };
      }
      const parentId = opts.forkSource.value?.trim();
      if (!parentId) {
        return { ok: false, error: "traecli fork: forkSource.value is required (parent native_id)" };
      }
      const cmd = `traecli${daemonArg}${altScreenArg}${postureArg}${modelArg}${queueStateDirArg} fork ${shellQuote(parentId)}`;
      const textResult = await this.tmux.sendShellCommand(binding.tmuxSession, this.seatLaunchEnvironment
        ? await this.seatLaunchEnvironment.command(binding.tmuxSession, cmd, { codexCwd: binding.cwd, nodeId: binding.nodeId, generation: binding.launchGeneration, runtime: this.runtime })
        : this.launchCommand(cmd));
      if (!textResult.ok) {
        return { ok: false, error: `Failed to send launch command: ${textResult.message}` };
      }
      const sessionId = await this.captureFreshThreadId(binding);
      if (sessionId) {
        return { ok: true, resumeToken: sessionId, resumeType: "traecli_id", appliedLaunch };
      }
      return { ok: true, appliedLaunch };
    }

    const cmd = opts.resumeToken
      ? `traecli${daemonArg}${altScreenArg}${postureArg}${modelArg}${queueStateDirArg} --resume ${shellQuote(opts.resumeToken)}`
      : `traecli${daemonArg}${altScreenArg}${postureArg}${modelArg} -C ${shellQuote(binding.cwd)} --add-dir ${shellQuote(binding.cwd)}${queueStateDirArg}`;

    const textResult = await this.tmux.sendShellCommand(binding.tmuxSession, this.seatLaunchEnvironment
        ? await this.seatLaunchEnvironment.command(binding.tmuxSession, cmd, { codexCwd: binding.cwd, nodeId: binding.nodeId, generation: binding.launchGeneration, runtime: this.runtime })
        : this.launchCommand(cmd));
    if (!textResult.ok) {
      return { ok: false, error: `Failed to send launch command: ${textResult.message}` };
    }

    if (opts.resumeToken) {
      return { ok: true, resumeToken: opts.resumeToken, resumeType: "traecli_id", appliedLaunch };
    }

    const sessionId = await this.captureFreshThreadId(binding);
    if (sessionId) {
      return { ok: true, resumeToken: sessionId, resumeType: "traecli_id", appliedLaunch };
    }

    return { ok: true, appliedLaunch };
  }

  private buildQueueStateAddDirArg(sessionName: string): string {
    const sharedDocsRoot = process.env.OPENRIG_SHARED_DOCS_ROOT?.trim()
      || nodePath.join(this.fs.homedir ?? os.homedir(), ".openrig", "shared-docs");
    const root = nodePath.join(sharedDocsRoot, sessionName, "queue-state");
    return root ? ` --add-dir ${shellQuote(root)}` : "";
  }

  private async captureProbeScreen(target: string): Promise<string> {
    if (this.tmux.capturePaneScreen) return await this.tmux.capturePaneScreen(target) ?? "";
    return await this.tmux.capturePaneContent(target, 40) ?? "";
  }

  async checkReady(binding: NodeBinding): Promise<ReadinessResult> {
    if (!binding.tmuxSession) {
      return { ready: false, reason: "No tmux session bound" };
    }
    const alive = await this.tmux.hasSession(binding.tmuxSession);
    if (!alive) {
      return { ready: false, reason: "tmux session not responsive" };
    }

    const paneCommand = await this.tmux.getPaneCommand(binding.tmuxSession);
    const paneContent = await this.captureProbeScreen(binding.tmuxSession);

    if (!paneCommand || !commandLooksLikeTraecli(paneCommand)) {
      return { ready: false, reason: "TraeCLI process not detected in pane" };
    }

    if (/[>#]\s*$/.test(paneContent.trim()) || /Session:\s*[0-9a-f-]{36}/i.test(paneContent)) {
      return { ready: true };
    }

    return { ready: false, reason: "TraeCLI is still loading" };
  }

  ensureManagedBootstrap(binding: { cwd?: string | null }): void {
    this.provisionWorkspaceTrust(binding.cwd ?? null);
  }

  private projectEntry(entry: ProjectionEntry, cwd: string, warnings: string[]): boolean {
    if (entry.category === "runtime_resource" && this.applyRuntimeResource(entry)) {
      return true;
    }

    if (entry.category === "guidance" && entry.mergeStrategy === "managed_block") {
      const targetPath = nodePath.join(cwd, "AGENTS.md");
      const content = this.fs.readFile(entry.absolutePath);
      return this.mergeGuidance(targetPath, entry.effectiveId, content, warnings);
    }

    if (entry.category === "plugin" && !this.pluginAppliesToTraecli(entry)) {
      return false;
    }

    const targetDir = this.resolveTargetDir(entry, cwd);
    if (!targetDir) return true;

    this.fs.mkdirp(targetDir);
    let isDir = false;
    if (this.fs.listFiles) {
      try {
        isDir = this.fs.listFiles(entry.absolutePath).length > 0;
      } catch {
        isDir = false;
      }
    }

    const createdFiles: string[] = [];
    try {
      if (isDir && this.fs.listFiles) {
        for (const file of this.fs.listFiles(entry.absolutePath)) {
          const src = nodePath.join(entry.absolutePath, file);
          const dest = nodePath.join(targetDir, file);
          const content = this.fs.readFile(src);
          if (this.fs.exists(dest) && hashContent(content) === hashContent(this.fs.readFile(dest))) {
            this.preserveMode(src, dest);
            continue;
          }
          const existed = this.fs.exists(dest);
          this.fs.mkdirp(nodePath.dirname(dest));
          this.fs.writeFile(dest, content);
          if (!existed) createdFiles.push(dest);
          this.preserveMode(src, dest);
        }
      } else {
        const content = this.fs.readFile(entry.absolutePath);
        const destFile = nodePath.join(targetDir, nodePath.basename(entry.absolutePath));
        if (this.fs.exists(destFile) && hashContent(content) === hashContent(this.fs.readFile(destFile))) {
          this.preserveMode(entry.absolutePath, destFile);
          return true;
        }
        const existed = this.fs.exists(destFile);
        this.fs.writeFile(destFile, content);
        if (!existed) createdFiles.push(destFile);
        this.preserveMode(entry.absolutePath, destFile);
      }
    } finally {
      if (entry.category === "plugin") warnings.push(...excludeNewGeneratedFiles(cwd, createdFiles));
    }
    return true;
  }

  private preserveMode(src: string, dest: string): void {
    if (!this.fs.statMode || !this.fs.chmod) return;
    const srcMode = this.fs.statMode(src) & 0o777;
    if ((this.fs.statMode(dest) & 0o777) !== srcMode) this.fs.chmod(dest, srcMode);
  }

  private pluginAppliesToTraecli(entry: ProjectionEntry): boolean {
    const explicit = entry.pluginType ?? "auto";
    if (explicit === "claude" || explicit === "codex") return false;
    return this.fs.exists(nodePath.join(entry.absolutePath, ".trae-plugin", "plugin.json"));
  }

  private resolveTargetDir(entry: ProjectionEntry, cwd: string): string | null {
    switch (entry.category) {
      case "skill": return nodePath.join(cwd, ".trae", "skills", entry.effectiveId);
      case "guidance": return null;
      case "subagent": return nodePath.join(cwd, ".trae", "agents");
      case "plugin": return nodePath.join(cwd, ".trae", "plugins", entry.effectiveId);
      case "runtime_resource": return nodePath.join(cwd, ".trae", "extensions", entry.effectiveId);
      default: return null;
    }
  }

  private applyRuntimeResource(entry: ProjectionEntry): boolean {
    if (entry.resourceType !== "traecli_config_fragment") {
      return false;
    }

    const configPath = this.resolveTraecliConfigPath();
    this.fs.mkdirp(nodePath.dirname(configPath));

    const existing = this.fs.exists(configPath) ? this.fs.readFile(configPath) : "";
    const fragment = this.fs.readFile(entry.absolutePath);
    assertFragmentParsesStandalone(fragment, entry.absolutePath, entry.effectiveId);
    assertFragmentOpensWithTable(fragment, entry.absolutePath, entry.effectiveId);
    const rendered = upsertManagedTraecliConfigFragment(existing, entry.effectiveId, fragment);
    assertRendersAsLoadableToml(rendered, configPath, entry.effectiveId);
    this.fs.writeFile(configPath, rendered);
    return true;
  }

  private mergeGuidance(targetPath: string, blockId: string, content: string, warnings: string[]): boolean {
    if (blockId === "rig-role") {
      console.log(
        `[openrig] skip: effectiveId is rig-role, per-seat delivery via send_text path required (target=${targetPath})`
      );
      return false;
    }
    mergeManagedBlock(this.fs, targetPath, blockId, content, {
      warnings,
      replaceBlockIds: blockId === "openrig-start.md" ? ["using-openrig.md"] : [],
    });
    return true;
  }

  private detectDeliveryHint(path: string, content: string): "guidance_merge" | "skill_install" | "send_text" {
    return resolveConcreteHint(path, content);
  }

  private provisionWorkspaceTrust(cwd: string | null): void {
    if (!cwd) return;
    const configPath = this.resolveTraecliConfigPath();
    this.fs.mkdirp(nodePath.dirname(configPath));

    let content = "";
    try {
      if (this.fs.exists(configPath)) content = this.fs.readFile(configPath);
    } catch {
      content = "";
    }

    for (const trustKey of this.workspaceTrustKeys(cwd)) {
      content = upsertTraecliProjectTrust(content, trustKey);
    }

    this.fs.writeFile(configPath, content);
  }

  private resolveTraecliConfigPath(): string {
    const root = this.traeHome
      ?? process.env.TRAE_HOME?.trim()
      ?? nodePath.join(this.fs.homedir ?? os.homedir(), ".trae");
    return nodePath.join(root, "traecli.toml");
  }

  private workspaceTrustKeys(cwd: string): string[] {
    const keys = new Set<string>([nodePath.resolve(cwd)]);
    try {
      keys.add(fs.realpathSync.native(cwd));
    } catch {
    }
    return Array.from(keys);
  }

  private async captureFreshThreadId(binding: NodeBinding): Promise<string | undefined> {
    const target = binding.tmuxPane ?? binding.tmuxSession;
    if (!target) return undefined;

    const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

    for (let attempt = 0; attempt < 20; attempt++) {
      const paneContent = await this.captureProbeScreen(target);
      const match = uuidPattern.exec(paneContent);
      if (match) {
        return match[0];
      }
      await this.sleep(500);
    }

    return undefined;
  }

  private launchCommand(command: string): string {
    const env = [
      this.launchPath ? `PATH=${shellQuote(this.launchPath)}` : "",
      this.traeHome ? `TRAE_HOME=${shellQuote(this.traeHome)}` : "",
    ].filter(Boolean);
    return env.length ? `env ${env.join(" ")} ${command}` : command;
  }
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function commandLooksLikeTraecli(command: string): boolean {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  return tokens.some((token) => {
    const unquoted = token.replace(/^['"]|['"]$/g, "");
    const base = nodePath.basename(unquoted);
    return base === "traecli";
  });
}

function upsertTraecliProjectTrust(content: string, projectPath: string): string {
  const header = `[projects.${JSON.stringify(projectPath)}]`;
  const lines = content.length > 0 ? content.split("\n") : [];
  const headerIndex = lines.findIndex((line) => line.trim() === header);

  if (headerIndex === -1) {
    const trimmed = content.trimEnd();
    const prefix = trimmed.length > 0 ? `${trimmed}\n\n` : "";
    return `${prefix}${header}\ntrust_level = "trusted"\n`;
  }

  let nextSectionIndex = lines.length;
  for (let i = headerIndex + 1; i < lines.length; i++) {
    if (lines[i]!.trim().startsWith("[")) {
      nextSectionIndex = i;
      break;
    }
  }

  const trustIndex = lines.findIndex((line, index) => index > headerIndex && index < nextSectionIndex && line.trim().startsWith("trust_level"));
  if (trustIndex >= 0) {
    lines[trustIndex] = 'trust_level = "trusted"';
  } else {
    lines.splice(headerIndex + 1, 0, 'trust_level = "trusted"');
  }

  return `${lines.join("\n").replace(/\n*$/, "\n")}`;
}

function canonicalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJsonValue);
  if (value !== null && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) out[key] = canonicalizeJsonValue(src[key]);
    return out;
  }
  return value;
}

const TRAECLI_HOOK_EVENT_KEY_LABEL: Record<(typeof OPENRIG_ACTIVITY_HOOK_EVENTS)[number], string> = {
  SessionStart: "session_start",
  UserPromptSubmit: "user_prompt_submit",
  Stop: "stop",
  PermissionRequest: "permission_request",
};

export interface TraecliHookTrustInput {
  keySource: string;
  command: string;
  timeoutSec: number;
  matcher?: string | null;
  statusMessage?: string | null;
  groupIndex?: number;
  handlerIndex?: number;
}

export function computeTraecliHookTrust(
  event: (typeof OPENRIG_ACTIVITY_HOOK_EVENTS)[number],
  input: TraecliHookTrustInput,
): { key: string; hash: string } {
  const label = TRAECLI_HOOK_EVENT_KEY_LABEL[event];
  const groupIndex = input.groupIndex ?? 0;
  const handlerIndex = input.handlerIndex ?? 0;
  const key = `${input.keySource}:${label}:${groupIndex}:${handlerIndex}`;

  const handler: Record<string, unknown> = {
    type: "command",
    command: input.command,
    timeout: input.timeoutSec,
    async: false,
  };
  if (input.statusMessage != null) handler.statusMessage = input.statusMessage;
  const identity: Record<string, unknown> = { event_name: label, hooks: [handler] };
  if (input.matcher != null) identity.matcher = input.matcher;

  const serialized = JSON.stringify(canonicalizeJsonValue(identity));
  const hex = createHash("sha256").update(serialized, "utf8").digest("hex");
  return { key, hash: `sha256:${hex}` };
}

export function upsertTraecliHookTrust(content: string, key: string, hash: string): string {
  const header = `[hooks.state.${JSON.stringify(key)}]`;
  const trustLine = `trusted_hash = ${JSON.stringify(hash)}`;
  const lines = content.length > 0 ? content.split("\n") : [];
  const headerIndex = lines.findIndex((line) => line.trim() === header);

  if (headerIndex === -1) {
    const trimmed = content.trimEnd();
    const prefix = trimmed.length > 0 ? `${trimmed}\n\n` : "";
    return `${prefix}${header}\n${trustLine}\n`;
  }

  let nextSectionIndex = lines.length;
  for (let i = headerIndex + 1; i < lines.length; i++) {
    if (lines[i]!.trim().startsWith("[")) {
      nextSectionIndex = i;
      break;
    }
  }

  const hashIndex = lines.findIndex(
    (line, index) => index > headerIndex && index < nextSectionIndex && line.trim().startsWith("trusted_hash"),
  );
  if (hashIndex >= 0) {
    lines[hashIndex] = trustLine;
  } else {
    lines.splice(headerIndex + 1, 0, trustLine);
  }

  return `${lines.join("\n").replace(/\n*$/, "\n")}`;
}

function isTraecliFeaturesHeader(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.startsWith("#")) return false;
  const match = /^\[([^[\]]*)\]\s*(#.*)?$/.exec(trimmed);
  if (!match) return false;
  let key = match[1]!.trim();
  if (
    key.length >= 2 &&
    ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'")))
  ) {
    key = key.slice(1, -1);
  }
  return key === "features";
}

function upsertTraecliFeaturesHooksEnabled(content: string): string {
  const lines = content.length > 0 ? content.replace(/\n*$/, "").split("\n") : [];
  const featuresIndex = lines.findIndex(isTraecliFeaturesHeader);
  if (featuresIndex === -1) {
    const prefix = lines.length > 0 ? `${lines.join("\n")}\n\n` : "";
    return `${prefix}[features]\nhooks = true\n`;
  }
  let nextSectionIndex = lines.length;
  for (let i = featuresIndex + 1; i < lines.length; i++) {
    if (lines[i]!.trim().startsWith("[")) { nextSectionIndex = i; break; }
  }
  const flagIndex = lines.findIndex(
    (line, index) => index > featuresIndex && index < nextSectionIndex && /^\s*hooks\s*=/.test(line)
  );
  if (flagIndex >= 0) {
    lines[flagIndex] = "hooks = true";
  } else {
    lines.splice(featuresIndex + 1, 0, "hooks = true");
  }
  return `${lines.join("\n")}\n`;
}

const OPENRIG_ACTIVITY_HOOKS_BEGIN = "# BEGIN OPENRIG MANAGED ACTIVITY HOOKS";
const OPENRIG_ACTIVITY_HOOKS_END = "# END OPENRIG MANAGED ACTIVITY HOOKS";
const OPENRIG_ACTIVITY_HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "Stop", "PermissionRequest"] as const;

function upsertTraecliActivityHooks(content: string, relayPath: string): string {
  const command = `'node "${relayPath}"'`;
  const stanzas = OPENRIG_ACTIVITY_HOOK_EVENTS
    .map((ev) => `[[hooks.${ev}]]\n[[hooks.${ev}.hooks]]\ntype = "command"\ncommand = ${command}\ntimeout = 5`)
    .join("\n\n");
  const block = `${OPENRIG_ACTIVITY_HOOKS_BEGIN}\n${stanzas}\n${OPENRIG_ACTIVITY_HOOKS_END}\n`;

  let next = upsertTraecliFeaturesHooksEnabled(content);

  const pattern = new RegExp(
    `${escapeRegExp(OPENRIG_ACTIVITY_HOOKS_BEGIN)}[\\s\\S]*?${escapeRegExp(OPENRIG_ACTIVITY_HOOKS_END)}\\n?`,
    "m"
  );
  if (pattern.test(next)) {
    return next.replace(pattern, () => block);
  }
  const prefix = next.replace(/\n*$/, "");
  return prefix.length > 0 ? `${prefix}\n\n${block}` : block;
}

function stripTraecliActivityHooks(content: string): string {
  const pattern = new RegExp(
    `\\n*${escapeRegExp(OPENRIG_ACTIVITY_HOOKS_BEGIN)}[\\s\\S]*?${escapeRegExp(OPENRIG_ACTIVITY_HOOKS_END)}[ \\t]*\\n?`,
    "m"
  );
  if (!pattern.test(content)) return content;
  return content.replace(pattern, "\n");
}

function lineStartsAtDocumentLevel(content: string): boolean[] {
  const out: boolean[] = [true];
  let multiline: '"""' | "'''" | null = null;
  let depth = 0;
  let i = 0;
  while (i < content.length) {
    const ch = content[i]!;
    if (multiline) {
      if (multiline === '"""' && ch === "\\") {
        if (content[i + 1] === "\n") out.push(false);
        i += 2;
        continue;
      }
      if (content.startsWith(multiline, i)) { multiline = null; i += 3; continue; }
      if (ch === "\n") out.push(false);
      i += 1;
      continue;
    }
    if (content.startsWith('"""', i)) { multiline = '"""'; i += 3; continue; }
    if (content.startsWith("'''", i)) { multiline = "'''"; i += 3; continue; }
    if (ch === "#") { while (i < content.length && content[i] !== "\n") i += 1; continue; }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i += 1;
      while (i < content.length && content[i] !== quote && content[i] !== "\n") {
        if (quote === '"' && content[i] === "\\") i += 1;
        i += 1;
      }
      if (content[i] === quote) i += 1;
      continue;
    }
    if (ch === "[" || ch === "{") { depth += 1; i += 1; continue; }
    if (ch === "]" || ch === "}") { depth = Math.max(0, depth - 1); i += 1; continue; }
    if (ch === "\n") { out.push(depth === 0); i += 1; continue; }
    i += 1;
  }
  return out;
}

function splitAtTableHeaders(fragment: string): Array<{ header: string | null; text: string }> {
  const structural = lineStartsAtDocumentLevel(fragment);
  const blocks: Array<{ header: string | null; lines: string[] }> = [{ header: null, lines: [] }];
  fragment.split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    if (structural[index] === true && trimmed.startsWith("[")) {
      blocks.push({ header: trimmed, lines: [line] });
      return;
    }
    blocks[blocks.length - 1]!.lines.push(line);
  });
  return blocks.map((b) => ({ header: b.header, text: b.lines.join("\n") }));
}

function parsesAsToml(candidate: string): boolean {
  try { parseToml(candidate); return true; } catch { return false; }
}

function assertFragmentOpensWithTable(fragment: string, sourcePath: string, id: string): void {
  const preamble = splitAtTableHeaders(fragment)[0];
  const declaresSomething = (preamble?.text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .some((line) => line.length > 0 && !line.startsWith("#"));
  if (!declaresSomething) return;
  throw new Error(
    `TraeCLI config fragment '${id}' declares root-level keys before its first table header ` +
    `(${sourcePath}); appended TOML cannot bind at document root — open a table first. ` +
    `Nothing was projected and the existing config was left unchanged.`,
  );
}

function assertFragmentParsesStandalone(fragment: string, sourcePath: string, id: string): void {
  try {
    parseToml(fragment);
  } catch (err) {
    throw new Error(
      `TraeCLI config fragment '${id}' is not valid TOML on its own (${sourcePath}); ` +
      `nothing was projected and the existing config was left unchanged. ${(err as Error).message}`,
    );
  }
}

function dropCollidingFragmentTables(
  fragment: string,
  userOwned: string,
): { kept: string; dropped: string[] } {
  const userParses = parsesAsToml(userOwned);
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const block of splitAtTableHeaders(fragment)) {
    const collides =
      block.header !== null &&
      userParses &&
      !parsesAsToml(`${userOwned}\n${block.text}`);
    if (collides) dropped.push(block.header!);
    else kept.push(block.text);
  }
  return {
    kept: kept.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "").replace(/\n*$/, ""),
    dropped,
  };
}

function upsertManagedTraecliConfigFragment(content: string, id: string, fragment: string): string {
  const start = `# BEGIN OPENRIG MANAGED TRAECLI CONFIG FRAGMENT: ${id}`;
  const end = `# END OPENRIG MANAGED TRAECLI CONFIG FRAGMENT: ${id}`;
  const pattern = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}\\n?`, "m");

  const userOwned = content.replace(pattern, "");
  const { kept } = dropCollidingFragmentTables(fragment, userOwned);
  const block = `${start}\n${kept}\n${end}\n`;

  if (pattern.test(content)) {
    return content.replace(pattern, () => block);
  }

  const prefix = content.replace(/\n*$/, "");
  return prefix.length > 0 ? `${prefix}\n\n${block}` : block;
}

function assertRendersAsLoadableToml(rendered: string, configPath: string, id: string): void {
  try {
    parseToml(rendered);
  } catch (err) {
    throw new Error(
      `TraeCLI config projection '${id}' would write a config TraeCLI cannot parse; ` +
      `${configPath} left unchanged. ${(err as Error).message}`,
    );
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
