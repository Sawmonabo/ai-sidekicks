// The standing rules: a project rule reaches every session of its project and no other; a new rule
// over a subject replaces the old one everywhere its provider keeps it; a revoke takes a project
// rule out of the project's file before it is recorded, and a failed removal leaves it in force; a
// closed session's own rules end with it; and a revoked subject is held until a rule covers it.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RememberedRuleId, RememberedScope } from "@ai-sidekicks/contracts/approval";
import type { EventEnvelope } from "@ai-sidekicks/contracts/event/envelope";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { NodeId } from "@ai-sidekicks/contracts/runtime-node/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { openScratchDatabase, type ScratchDatabase } from "../../database/__fixtures__/scratch.js";
import { EventLogService } from "../../events/log-service.js";
import type { RevokeRuleParams } from "../../provider/driver/session-control.js";
import type { ProviderAskAction } from "../../provider/port/permission-ask.js";
import { describeProviderAsk } from "../ask-description.js";
import { ApprovalRules, type RecordedRule } from "../rules.js";
import { ApprovalService } from "../service.js";
import type { StoredApprovalRequest } from "../store.js";

// Two sessions of one project, and a chat beside them.
const SESSION_A = "00000000-0000-7000-8000-00000000000a" as SessionId;
const SESSION_B = "00000000-0000-7000-8000-00000000000b" as SessionId;
const CHAT = "00000000-0000-7000-8000-00000000000c" as SessionId;
const RUN_OF: Record<SessionId, RunId> = {
  [SESSION_A]: "00000000-0000-7000-8000-0000000000a1" as RunId,
  [SESSION_B]: "00000000-0000-7000-8000-0000000000b1" as RunId,
  [CHAT]: "00000000-0000-7000-8000-0000000000c1" as RunId,
};
const FOLDER_A = "/work/project-a";
const CREATED_AT = "2026-10-11T00:00:00.000Z";
const HOST = { kind: "network", host: "example.com" } as const;

let database: ScratchDatabase;
let service: ApprovalService;
let rules: ApprovalRules;
// Each provider handover, in order, with whether the revoke was already recorded when it ran.
let handovers: (RevokeRuleParams & { revokeRecorded: boolean })[];
let failFileRemoval: boolean;
let committedListener: ((event: EventEnvelope) => void) | undefined;

beforeEach(async () => {
  database = await openScratchDatabase();
  await database.writer.write([
    {
      sql: `INSERT INTO projects (id, name, slug, folder_path, state, setup, created_at, updated_at)
            VALUES ('project-1', 'Project', 'project', '/repos/project', 'active', '{}', ?, ?)`,
      bindings: [CREATED_AT, CREATED_AT],
    },
    {
      sql: `INSERT INTO sessions (id, shape, state, created_at, updated_at, last_activity_at)
            VALUES (?, 'project', 'active', ?, ?, ?), (?, 'project', 'active', ?, ?, ?),
                   (?, 'chat', 'active', ?, ?, ?)`,
      bindings: [SESSION_A, SESSION_B, CHAT].flatMap((id) => [
        id,
        CREATED_AT,
        CREATED_AT,
        CREATED_AT,
      ]),
    },
    {
      sql: `INSERT INTO session_create_requests
              (client_idempotency_key, session_id, project_id, execution_mode)
            VALUES ('key-a', ?, 'project-1', 'bound-root'), ('key-b', ?, 'project-1', 'bound-root'),
                   ('key-c', ?, NULL, 'bound-root')`,
      bindings: [SESSION_A, SESSION_B, CHAT],
    },
    {
      sql: `INSERT INTO runs (run_id, session_id, state, run_version)
            VALUES (?, ?, 'running', 1), (?, ?, 'running', 1), (?, ?, 'running', 1)`,
      bindings: [SESSION_A, SESSION_B, CHAT].flatMap((id) => [RUN_OF[id], id]),
    },
  ]);
  const sessionEvents = new EventLogService({
    writer: database.writer,
    reader: database.reader,
    writeServiceLog: (line) => {
      throw new Error(`unexpected service log line: ${line}`);
    },
  });
  service = new ApprovalService({
    reader: database.reader,
    sessionEvents,
    followAll: () => () => {},
    workingFolders: { raiseStaleness: async () => {} },
    writeServiceLog: (line) => {
      throw new Error(`unexpected service log line: ${line}`);
    },
  });
  handovers = [];
  failFileRemoval = false;
  committedListener = undefined;
  rules = new ApprovalRules({
    reader: database.reader,
    sessionEvents,
    nodeId: "node-local" as NodeId,
    followAll: (onCommitted) => {
      committedListener = onCommitted;
      return () => {};
    },
    readWorkingFolder: (sessionId) => (sessionId === SESSION_A ? FOLDER_A : undefined),
    revokeAtProvider: async (revocation) => {
      if (revocation.projectFolder !== undefined && failFileRemoval) {
        throw new Error("the project's settings file is not writable");
      }
      handovers.push({ ...revocation, revokeRecorded: readRevokeTriggers().length > 0 });
    },
    writeServiceLog: (line) => {
      throw new Error(`unexpected service log line: ${line}`);
    },
  });
});

afterEach(async () => {
  await database.close();
});

// Raises an ask for `action` on the session's run and records the rule of `scope` its answer made.
async function makeRule(
  sessionId: SessionId,
  action: ProviderAskAction,
  scope: Pick<RememberedScope, "kind" | "sense">,
): Promise<{ stored: StoredApprovalRequest; recorded: RecordedRule }> {
  const description = describeProviderAsk({
    sessionId,
    runId: RUN_OF[sessionId],
    requestId: "ask-1",
    toolName: "WebFetch",
    input: {},
    action,
    ruleScopes: ["session", "project"],
  });
  const { approvalRequestId } = await service.create({
    sessionId,
    runId: RUN_OF[sessionId],
    requestedBy: "agent-1",
    ...description,
  });
  const stored = service.readRequest(approvalRequestId);
  if (stored === undefined) {
    throw new Error(`no request ${approvalRequestId}`);
  }
  const recorded = await rules.record(stored, action.kind, {
    ...scope,
    pattern: description.resourceDescriptor.subject,
  });
  return { stored, recorded };
}

function ruleIdOf(stored: StoredApprovalRequest): RememberedRuleId {
  return stored.approvalRequestId as unknown as RememberedRuleId;
}

function readRevokeTriggers(): { ruleId: string; invalidationTrigger: string }[] {
  return database.reader
    .prepare<[], { payload: string }>(
      "SELECT payload FROM session_events WHERE type = 'approval.rule_revoked' ORDER BY sequence",
    )
    .all()
    .map((row) => JSON.parse(row.payload) as { ruleId: string; invalidationTrigger: string });
}

describe("ApprovalRules", () => {
  it("reaches every session of the project with a project rule, and no session outside it", async () => {
    await makeRule(SESSION_A, HOST, { kind: "project", sense: "block" });
    await makeRule(
      SESSION_A,
      { kind: "command", command: "npm test" },
      { kind: "session", sense: "allow" },
    );

    expect(rules.readSessionRules(SESSION_B)).toEqual([
      { kind: "project", sense: "block", action: "network", subject: "example.com" },
    ]);
    expect(rules.findRule(SESSION_B, "network", "example.com")?.sense).toBe("block");
    expect(rules.readSessionRules(SESSION_A)).toHaveLength(2);
    expect(rules.readSessionRules(CHAT)).toEqual([]);

    // The session's own allow over the subject does not outrank the project's block.
    await makeRule(SESSION_B, HOST, { kind: "session", sense: "allow" });

    expect(rules.findRule(SESSION_B, "network", "example.com")?.sense).toBe("block");
  });

  it("replaces a project rule over the same subject, out of its file and every session's rules", async () => {
    const { stored: blocked } = await makeRule(SESSION_A, HOST, {
      kind: "project",
      sense: "block",
    });
    handovers = [];

    const { recorded: replacing } = await makeRule(SESSION_B, HOST, {
      kind: "project",
      sense: "allow",
    });
    await rules.handOutRules(SESSION_B, replacing.replaced);

    const block = { kind: "project", sense: "block", action: "network", subject: "example.com" };
    expect(replacing.replaced).toEqual([block]);
    expect(readRevokeTriggers()).toMatchObject([
      { ruleId: blocked.approvalRequestId, invalidationTrigger: "explicit" },
    ]);
    // Out of the file the session that made it works in, before the revoke was recorded; then
    // each session of the project reads its rules again.
    expect(handovers).toEqual([
      { sessionId: SESSION_A, rule: block, projectFolder: FOLDER_A, revokeRecorded: false },
      { sessionId: SESSION_A, rule: block, projectFolder: undefined, revokeRecorded: true },
      { sessionId: SESSION_B, rule: block, projectFolder: undefined, revokeRecorded: true },
    ]);
    expect(rules.findRule(SESSION_A, "network", "example.com")?.sense).toBe("allow");
  });

  it("leaves a project rule in force when its file removal fails, and revokes it on a retry", async () => {
    const { stored: made } = await makeRule(SESSION_A, HOST, { kind: "project", sense: "block" });
    handovers = [];
    failFileRemoval = true;

    await expect(rules.revoke(ruleIdOf(made))).rejects.toThrow("not writable");
    expect(readRevokeTriggers()).toEqual([]);
    expect(rules.list(SESSION_B).rules).toHaveLength(1);

    failFileRemoval = false;
    await rules.revoke(ruleIdOf(made));

    expect(
      handovers.map(({ sessionId, projectFolder, revokeRecorded }) => ({
        sessionId,
        projectFolder,
        revokeRecorded,
      })),
    ).toEqual([
      { sessionId: SESSION_A, projectFolder: FOLDER_A, revokeRecorded: false },
      { sessionId: SESSION_A, projectFolder: undefined, revokeRecorded: true },
      { sessionId: SESSION_B, projectFolder: undefined, revokeRecorded: true },
    ]);
    expect(rules.readSessionRules(SESSION_B)).toEqual([]);
    await expect(rules.revoke(ruleIdOf(made))).rejects.toMatchObject({
      code: "approval.rule_already_revoked",
    });
    await expect(
      rules.revoke("00000000-0000-7000-8000-0000000000ff" as RememberedRuleId),
    ).rejects.toMatchObject({ code: "approval.rule_not_found" });
  });

  it("ends a closed session's own rules and keeps its project's", async () => {
    const { stored: own } = await makeRule(
      SESSION_A,
      { kind: "command", command: "npm test" },
      {
        kind: "session",
        sense: "allow",
      },
    );
    await makeRule(SESSION_A, HOST, { kind: "project", sense: "block" });
    rules.start();

    committedListener?.({ type: "session.closed", sessionId: SESSION_A } as EventEnvelope);
    await rules.stop();

    expect(readRevokeTriggers()).toEqual([
      expect.objectContaining({
        ruleId: own.approvalRequestId,
        invalidationTrigger: "session_end",
      }),
    ]);
    expect(rules.readSessionRules(SESSION_B)).toHaveLength(1);
  });

  it("names a revoked subject until a rule in force covers it again", async () => {
    const npmTest = { kind: "command", command: "npm test --watch" } as const;
    const { stored: made } = await makeRule(SESSION_A, npmTest, {
      kind: "session",
      sense: "allow",
    });
    await rules.revoke(ruleIdOf(made));

    expect(rules.findRevokedRule(SESSION_A, npmTest)).toMatchObject({ subject: "npm test" });
    expect(rules.findRevokedRule(SESSION_A, { kind: "command", command: "npm run x" })).toBe(
      undefined,
    );
    expect(rules.findRevokedRule(SESSION_B, npmTest)).toBe(undefined);

    await makeRule(SESSION_A, npmTest, { kind: "session", sense: "allow" });

    expect(rules.findRevokedRule(SESSION_A, npmTest)).toBe(undefined);
  });
});
