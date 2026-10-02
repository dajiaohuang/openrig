import { describe, expect, it, vi } from "vitest";
import { BootstrapOrchestrator } from "../src/domain/bootstrap-orchestrator.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { deriveComposeProjectName } from "../src/domain/compose-project-name.js";
import { createFullTestDb } from "./helpers/test-app.js";

type PrelaunchHook = (rigId: string) => Promise<{ ok: boolean }>;
type ServiceHookAccess = {
  buildServicePrelaunchHook(
    yaml: string, root: string, stages: unknown[], errors: string[],
  ): Promise<PrelaunchHook | undefined>;
};

describe("bootstrap Compose project identity", () => {
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
