// NodeRegistry over a real SQLite file: the registration is keyed by machine and owning user; the
// machine's owner is the local one minted at the first start, so an agent's workflow start is
// allowed with no hosted sign-in, and a registration under any other user leaves no owner to
// decide as. A registration needs no session, and a re-registration keeps the first-seen time.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { WorkflowDefinitionId } from "@ai-sidekicks/contracts/workflow/definition/document";

import { HOST_OPERATING_SYSTEM } from "../../tests/helpers/host-operating-system.js";
import { readOrMintLocalMachine } from "../daemon/machine/local.js";
import { openScratchDatabase, type ScratchDatabase } from "../database/__fixtures__/scratch.js";
import type { NodeTrustStateRow } from "../node-registry.js";
import { NodeRegistry } from "../node-registry.js";
import { loadAuthorizer } from "../policy/authorizer.js";
import { PermissionCheckService } from "../policy/permission-check.js";

// `NodeId` is a daemon-minted opaque scalar, not a UUID.
const NODE_ID: string = "node-01J0ND0000NN5J5J5J5J5J5J";
const OWNER_USER_ID: string = "01J0PA0000NN5J5J5J5J5J5J5J";
const OTHER_USER_ID: string = "01J0PB0000NN5J5J5J5J5J5J5J";

let scratch: ScratchDatabase;

beforeEach(async () => {
  scratch = await openScratchDatabase();
});

afterEach(async () => {
  await scratch.close();
});

function tableRowCount(tableName: string): number {
  const row = scratch.reader.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as {
    count: number;
  };
  return row.count;
}

describe("NodeRegistry", () => {
  it("keys the registration by machine and owning user", async () => {
    const registry = new NodeRegistry(scratch);
    expect(registry.lookup(NODE_ID, OWNER_USER_ID)).toBeUndefined();

    await registry.register({ nodeId: NODE_ID, ownerUserId: OWNER_USER_ID });

    expect(registry.lookup(NODE_ID, OWNER_USER_ID)).toBeDefined();
    expect(registry.lookup(NODE_ID, OTHER_USER_ID)).toBeUndefined();
    expect(registry.lookup("node-never-registered", OWNER_USER_ID)).toBeUndefined();
  });

  it("starts an agent's workflow as the local owner unsigned, never as another user", async () => {
    let namesRead = 0;
    const readName = (): Promise<string> => {
      namesRead += 1;
      return Promise.resolve("Test Machine");
    };
    const now = (): Date => new Date("2026-06-02T12:00:00.000Z");
    const machine = await readOrMintLocalMachine(scratch, readName, now);
    expect(await readOrMintLocalMachine(scratch, readName, now)).toStrictEqual(machine);
    expect(namesRead).toBe(1);

    const registry = new NodeRegistry(scratch);
    const decided: unknown[] = [];
    const authorizer = await loadAuthorizer();
    const check = new PermissionCheckService({
      authorizer: {
        decide: (request) => {
          decided.push(request.principal);
          return authorizer.decide(request);
        },
      },
      approvals: {
        create: () => Promise.reject(new Error("a workflow start raises no card")),
        takeCorrection: () => Promise.resolve(false),
      },
      rules: { findRule: () => undefined },
      agentMemoryFolder: "/data/agent-memory",
      pathRules: HOST_OPERATING_SYSTEM.pathRules,
      readRunAgent: () => "agent-1",
      readOwner: () => registry.readOwner(machine),
      readPosture: () => ({
        mode: "ask",
        writableRoots: [],
        credentialPolicyRef: "curated-credentials",
      }),
    });
    const agentStart = {
      kind: "workflow_start",
      workflowId: "workflow-1" as WorkflowDefinitionId,
      askingRunId: "00000000-0000-7000-8000-0000000000b1" as RunId,
    } as const;

    // Unregistered, then registered under its own owner: the start is the local owner's.
    expect(await check.check(agentStart)).toEqual({ allowed: true, reason: "policy_allow" });
    await registry.register({ nodeId: machine.nodeId, ownerUserId: machine.ownerUserId });
    expect(await check.check(agentStart)).toEqual({ allowed: true, reason: "policy_allow" });
    expect(decided).toEqual([machine.ownerUserId, machine.ownerUserId]);

    // Registered under a second user too, the machine has no one owner, so the start is refused.
    await registry.register({ nodeId: machine.nodeId, ownerUserId: OTHER_USER_ID });
    expect(await check.check(agentStart)).toMatchObject({ allowed: false, reason: "denied" });
    // Registered under another user alone, the same.
    const otherMachine = { ...machine, nodeId: NODE_ID as typeof machine.nodeId };
    await registry.register({ nodeId: NODE_ID, ownerUserId: OTHER_USER_ID });
    expect(registry.readOwner(otherMachine)).toBeUndefined();
  });

  it("registers without a session: only the registration row is written", async () => {
    const beforeSnapshots: number = tableRowCount("session_snapshots");

    await new NodeRegistry(scratch).register({ nodeId: NODE_ID, ownerUserId: OWNER_USER_ID });

    expect(tableRowCount("node_trust_state")).toBe(1);
    expect(tableRowCount("session_events")).toBe(0);
    expect(tableRowCount("session_snapshots")).toBe(beforeSnapshots);
  });

  it("refreshes only updated_at on re-registration", async () => {
    const clock: string[] = ["2026-06-02T12:00:00.000Z", "2026-06-03T08:30:00.000Z"];
    let tick: number = 0;
    const registry = new NodeRegistry(scratch, () => {
      const instant: string | undefined = clock[tick++];
      if (instant === undefined) {
        throw new Error("the test clock ran out of instants");
      }
      return instant;
    });

    await registry.register({ nodeId: NODE_ID, ownerUserId: OWNER_USER_ID });
    await registry.register({ nodeId: NODE_ID, ownerUserId: OWNER_USER_ID });

    expect(tableRowCount("node_trust_state")).toBe(1);
    const row: NodeTrustStateRow | undefined = registry.lookup(NODE_ID, OWNER_USER_ID);
    expect(row?.established_at).toBe(clock[0]);
    expect(row?.updated_at).toBe(clock[1]);
  });
});
