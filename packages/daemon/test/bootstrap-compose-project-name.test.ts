import { describe, expect, it, vi } from "vitest";
import { BootstrapOrchestrator } from "../src/domain/bootstrap-orchestrator.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { deriveComposeProjectName } from "../src/domain/compose-project-name.js";
import { createFullTestDb } from "./helpers/test-app.js";
import { ServiceOrchestrator } from "../src/domain/service-orchestrator.js";
import { ComposeServicesAdapter } from "../src/adapters/compose-services-adapter.js";

type PrelaunchHook = (rigId: string, replacedRigIds?: readonly string[]) => Promise<{ ok: boolean }>;
type ServiceHookAccess = {
  buildServicePrelaunchHook(
    yaml: string, root: string, stages: unknown[], errors: string[],
  ): Promise<PrelaunchHook | undefined>;
};

describe("bootstrap Compose project identity", () => {
  it.each(["success", "failure", "explicit", "ambiguous"])("uses exact predecessors and protects retained projects (%s)", async (scenario) => {
    const db = createFullTestDb();
    try {
      const rigRepo = new RigRepository(db);
      const commands: string[] = [];
      const adapter = new ComposeServicesAdapter(async cmd => {
        commands.push(cmd);
        if (scenario === "failure" && cmd.includes("up -d")) throw new Error("test boot failure");
        return "";
      });
      const serviceOrchestrator = new ServiceOrchestrator({ rigRepo, composeAdapter: adapter });
      const dbHandle = { db };
      const orchestrator = new BootstrapOrchestrator({
        db, rigRepo, serviceOrchestrator, bootstrapRepo: dbHandle,
        runtimeVerifier: dbHandle, installExecutor: dbHandle, packageInstallService: dbHandle,
      } as ConstructorParameters<typeof BootstrapOrchestrator>[0]);
      const store = (id: string, projectName: string) => rigRepo.setServicesRecord(id, {
        kind: "compose", specJson: JSON.stringify({ kind: "compose", composeFile: "compose.yaml", projectName }),
        rigRoot: process.cwd(), composeFile: "compose.yaml", projectName,
      });
      const historical = rigRepo.createRig("demo-rig");
      store(historical.id, "unrelated-old-project");
      rigRepo.archiveRig(historical.id);
      const predecessor = rigRepo.createRig("demo-rig");
      store(predecessor.id, "legacy-project");
      rigRepo.archiveRig(predecessor.id);
      const replaced = [predecessor.id];
      if (scenario === "ambiguous") {
        const other = rigRepo.createRig("demo-rig");
        store(other.id, "another-project");
        rigRepo.archiveRig(other.id);
        replaced.push(other.id);
      }
      const current = rigRepo.createRig("demo-rig");
      const yaml = `version: "0.2"
name: demo-rig
services:
  kind: compose
  compose_file: compose.yaml
${scenario === "explicit" ? "  project_name: requested-project\n" : ""}pods:
  - id: dev
    label: Development
    members:
      - id: impl
        agent_ref: local:agents/impl
        runtime: claude-code
        profile: default
        cwd: .
    edges: []
edges: []
`;
      const hook = await (orchestrator as unknown as ServiceHookAccess).buildServicePrelaunchHook(yaml, process.cwd(), [], []);
      const result = await hook!(current.id, replaced);
      expect(result.ok).toBe(scenario !== "failure" && scenario !== "ambiguous");
      if (scenario === "ambiguous") {
        expect(commands).toEqual([]);
        expect(rigRepo.getServicesRecord(current.id)).toBeNull();
      } else {
        const expected = scenario === "explicit" ? "requested-project" : "legacy-project";
        expect(rigRepo.getServicesRecord(current.id)!.projectName).toBe(expected);
        expect(commands.some(cmd => cmd.includes(`-p '${expected}'`) && cmd.includes("up -d"))).toBe(true);
        expect(commands.some(cmd => cmd.includes("down"))).toBe(false);
        if (scenario === "success") {
          // Even explicit volume cleanup on the archived generation cannot destroy the live project.
          commands.length = 0;
          await serviceOrchestrator.teardown(predecessor.id, { policyOverride: "down_and_volumes" });
          expect(commands).toEqual([]);
          await serviceOrchestrator.teardown(current.id);
          expect(commands.some(cmd => cmd.includes("-p 'legacy-project'") && cmd.includes("down"))).toBe(true);
        }
      }
    } finally {
      db.close();
    }
  });

  it.each([undefined, "explicit-project"])("persists the actual project in both record and spec (%s)", async (explicit) => {
    const db = createFullTestDb();
    try {
      const rigRepo = new RigRepository(db);
      const serviceOrchestrator = { boot: vi.fn(async () => ({ ok: true, receipt: {}, health: [] })) };
      // Other stages only participate in constructor DB-handle checks here.
      const dbHandle = { db };
      const orchestrator = new BootstrapOrchestrator({
        db, rigRepo, serviceOrchestrator, bootstrapRepo: dbHandle,
        runtimeVerifier: dbHandle, installExecutor: dbHandle, packageInstallService: dbHandle,
      } as
        ConstructorParameters<typeof BootstrapOrchestrator>[0]);
      const hookAccess = orchestrator as unknown as ServiceHookAccess;
      const yaml = `version: "0.2"
name: demo-rig
services:
  kind: compose
  compose_file: compose.yaml
${explicit ? `  project_name: ${explicit}\n` : ""}pods:
  - id: dev
    label: Development
    members:
      - id: impl
        agent_ref: local:agents/impl
        runtime: claude-code
        profile: default
        cwd: .
    edges: []
edges: []
`;
      const hook = await hookAccess.buildServicePrelaunchHook(yaml, process.cwd(), [], []);
      expect(hook).toBeDefined();
      const first = rigRepo.createRig("demo-rig");
      const second = rigRepo.createRig("demo-rig-2");
      for (const rig of [first, second]) {
        expect(await hook!(rig.id)).toEqual({ ok: true });
        const stored = rigRepo.getServicesRecord(rig.id)!;
        const expected = explicit ?? deriveComposeProjectName(rig.id);
        expect(stored.projectName).toBe(expected);
        expect(JSON.parse(stored.specJson).projectName).toBe(expected);
        expect(serviceOrchestrator.boot).toHaveBeenCalledWith(rig.id);
      }
      if (!explicit) {
        expect(rigRepo.getServicesRecord(first.id)!.projectName)
          .not.toBe(rigRepo.getServicesRecord(second.id)!.projectName);
      }
    } finally {
      db.close();
    }
  });
});
