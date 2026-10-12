// The standing rules: a project rule reaches every session of its project and no other; a new rule
// over a subject replaces the old one everywhere its provider keeps it; a rule whose record fails
// is taken back out of its provider; a revoke takes a project rule out of every working folder of
// the project before it is recorded, a failed removal leaves it in force, and two revokes at once
// record one; a purge takes a session's project rules out of the providers; a closed session's own
// rules end with it, at the next start when it closed while the daemon was down; and a revoked
// subject is held until a rule covers it.

import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RememberedRuleId, RememberedScope } from "@ai-sidekicks/contracts/approval";
import type { EventEnvelope } from "@ai-sidekicks/contracts/event/envelope";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { NodeId } from "@ai-sidekicks/contracts/runtime-node/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { DeviceId } from "@ai-sidekicks/contracts/trust-statement";

import { openScratchDatabase, type ScratchDatabase } from "../../database/__fixtures__/scratch.js";
import { EventLogService } from "../../events/log-service.js";
import type { RevokeRuleParams } from "../../provider/driver/session-control.js";
import type { ProviderAskAction } from "../../provider/port/permission-ask.js";
import { describeProviderAsk } from "../ask-description.js";
import { ApprovalRules } from "../rules.js";
import { ApprovalService } from "../service.js";
import type { StoredApprovalRequest } from "../store.js";

// Two sessions of one project, and a chat beside them.
const SESSION_A = "00000000-0000-7000-8000-00000000000a" as SessionId;
const SESSION_B = "00000000-0000-7000-8000-00000000000b" as SessionId;
const CHAT = "00000000-0000-7000-8000-00000000000c" as SessionId;
const RUN_IDS = new Map<SessionId, RunId>([
  [SESSION_A, "00000000-0000-7000-8000-0000000000a1" as RunId],
  [SESSION_B, "00000000-0000-7000-8000-0000000000b1" as RunId],
  [CHAT, "00000000-0000-7000-8000-0000000000c1" as RunId],
]);

// The one run each session holds.
function runOf(sessionId: SessionId): RunId {
  const runId = RUN_IDS.get(sessionId);
  if (runId === undefined) {
    throw new Error(`no run for session ${sessionId}`);
  }
  return runId;
}
// The working folders of the project: each session's worktree, and one A archived.
const FOLDER_A = "/work/project-a";
const FOLDER_A_ARCHIVED = "/work/project-a-old";
const FOLDER_B = "/work/project-b";
const PROJECT_FOLDERS = [FOLDER_A, FOLDER_A_ARCHIVED, FOLDER_B];
const CREATED_AT = "2026-10-11T00:00:00.000Z";
const HOST = { kind: "network", host: "example.com" } as const;

let database: ScratchDatabase;
let service: ApprovalService;
let rules: ApprovalRules;
// Each provider handover, in order, with whether the revoke was already recorded when it ran.
let handovers: (RevokeRuleParams & { revokeRecorded: boolean })[];
let failFileRemoval: boolean;
let failRuleRecord: boolean;
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
      bindings: [SESSION_A, SESSION_B, CHAT].flatMap((id) => [runOf(id), id]),
    },
    {
      sql: `INSERT INTO repo_mounts (id, node_id, local_path, canonical_root, project_id,
              attached_at, updated_at)
            VALUES ('mount-1', 'node-local', '/repos/project', '/repos/project', 'project-1', ?, ?)`,
      bindings: [CREATED_AT, CREATED_AT],
    },
    {
      sql: `INSERT INTO workspaces (id, session_id, repo_mount_id, execution_mode, fs_root, state,
              created_at, updated_at)
            VALUES ('ws-a', ?, 'mount-1', 'provisioned-worktree', ?, 'ready', ?, ?),
                   ('ws-a-old', ?, 'mount-1', 'provisioned-worktree', ?, 'archived', ?, ?),
                   ('ws-b', ?, 'mount-1', 'provisioned-worktree', ?, 'ready', ?, ?)`,
      bindings: [
        [SESSION_A, FOLDER_A],
        [SESSION_A, FOLDER_A_ARCHIVED],
        [SESSION_B, FOLDER_B],
      ].flatMap(([id, folder]) => [id, folder, CREATED_AT, CREATED_AT]),
    },
  ]);
  const eventLog = new EventLogService({
    writer: database.writer,
    reader: database.reader,
    writeServiceLog: (line) => {
      throw new Error(`unexpected service log line: ${line}`);
    },
  });
  // The log as the rules write it, refusing a rule's record while `failRuleRecord` is set.
  const sessionEvents = {
    append: async (...args: Parameters<EventLogService["append"]>) => {
      if (failRuleRecord && args[0].type === "approval.remembered") {
        throw new Error("the log is full");
      }
      return await eventLog.append(...args);
    },
    appendThinkingUpdate: eventLog.appendThinkingUpdate.bind(eventLog),
  };
  service = new ApprovalService({
    reader: database.reader,
    writer: database.writer,
    sessionEvents,
    followAll: () => () => {},
    workingFolders: { raiseStaleness: async () => {} },
    writeServiceLog: (line) => {
      throw new Error(`unexpected service log line: ${line}`);
    },
  });
  handovers = [];
  failFileRemoval = false;
  failRuleRecord = false;
  committedListener = undefined;
  rules = new ApprovalRules({
    reader: database.reader,
    sessionEvents,
    nodeId: "node-local" as NodeId,
    followAll: (onCommitted) => {
      committedListener = onCommitted;
      return () => {};
    },
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
): Promise<{ stored: StoredApprovalRequest }> {
  const description = describeProviderAsk({
    sessionId,
    runId: runOf(sessionId),
    requestId: "ask-1",
    toolName: "WebFetch",
    input: {},
    action,
    ruleScopes: ["session", "project"],
    isProviderFlagged: false,
  });
  const { approvalRequestId } = await service.create({
    sessionId,
    runId: runOf(sessionId),
    requestedBy: "agent-1",
    ...description,
  });
  // The answer is recorded first, as a resolve records it before its rule.
  await service.resolve(
    { approvalRequestId, decision: "approved", clientResolutionId: randomUUID() },
    "device-laptop" as DeviceId,
  );
  const stored = service.readRequest(approvalRequestId);
  if (stored === undefined) {
    throw new Error(`no request ${approvalRequestId}`);
  }
  await rules.record(stored, {
    rule: { ...scope, action: action.kind, subject: description.resourceDescriptor.subject },
    projectFolders: scope.kind === "project" ? rules.readProjectFolders(sessionId) : [],
  });
  return { stored };
}

// The handovers, each session's hand-out of its rules in session order, since the project's
// sessions are read in no set order.
function readHandovers(): (RevokeRuleParams & { revokeRecorded: boolean })[] {
  return handovers.toSorted((first, second) =>
    first.projectFolder === undefined && second.projectFolder === undefined
      ? first.sessionId.localeCompare(second.sessionId)
      : 0,
  );
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
    // B's own allow over the host is older than the project's block, which still outranks it.
    await makeRule(SESSION_B, HOST, { kind: "session", sense: "allow" });
    await makeRule(SESSION_A, HOST, { kind: "project", sense: "block" });
    await makeRule(
      SESSION_A,
      { kind: "command", command: "npm test" },
      { kind: "session", sense: "allow" },
    );

    expect(rules.readSessionRules(SESSION_B)).toEqual([
      { kind: "session", sense: "allow", action: "network", subject: "example.com" },
      { kind: "project", sense: "block", action: "network", subject: "example.com" },
    ]);
    expect(rules.findRule(SESSION_B, "network", "example.com")?.sense).toBe("block");
    expect(rules.readSessionRules(SESSION_A)).toHaveLength(2);
    expect(rules.readSessionRules(CHAT)).toEqual([]);
  });

  it("replaces a project rule over the same subject, out of every folder and session's rules", async () => {
    const { stored: blocked } = await makeRule(SESSION_A, HOST, {
      kind: "project",
      sense: "block",
    });
    handovers = [];

    await makeRule(SESSION_B, HOST, { kind: "project", sense: "allow" });

    const block = { kind: "project", sense: "block", action: "network", subject: "example.com" };
    expect(readRevokeTriggers()).toMatchObject([
      { ruleId: blocked.approvalRequestId, invalidationTrigger: "explicit" },
    ]);
    // Out of every working folder of the project, an archived one's too, before the revoke was
    // recorded; then each session of the project reads its rules again.
    expect(readHandovers()).toEqual([
      ...PROJECT_FOLDERS.map((projectFolder) => ({
        sessionId: SESSION_A,
        rule: block,
        projectFolder,
        revokeRecorded: false,
      })),
      { sessionId: SESSION_A, rule: block, projectFolder: undefined, revokeRecorded: true },
      { sessionId: SESSION_B, rule: block, projectFolder: undefined, revokeRecorded: true },
    ]);
    expect(rules.findRule(SESSION_A, "network", "example.com")?.sense).toBe("allow");
  });

  it("takes a rule whose record failed back out of its provider, and keeps the rule it replaced", async () => {
    await makeRule(SESSION_A, HOST, { kind: "project", sense: "block" });
    handovers = [];
    failRuleRecord = true;

    await expect(makeRule(SESSION_B, HOST, { kind: "project", sense: "allow" })).rejects.toThrow(
      "the log is full",
    );

    const allow = { kind: "project", sense: "allow", action: "network", subject: "example.com" };
    expect(readHandovers()).toEqual([
      ...PROJECT_FOLDERS.map((projectFolder) => ({
        sessionId: SESSION_B,
        rule: allow,
        projectFolder,
        revokeRecorded: false,
      })),
      { sessionId: SESSION_A, rule: allow, projectFolder: undefined, revokeRecorded: false },
      { sessionId: SESSION_B, rule: allow, projectFolder: undefined, revokeRecorded: false },
    ]);
    expect(readRevokeTriggers()).toEqual([]);
    expect(rules.findRule(SESSION_B, "network", "example.com")?.sense).toBe("block");
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
      readHandovers().map(({ sessionId, projectFolder, revokeRecorded }) => ({
        sessionId,
        projectFolder,
        revokeRecorded,
      })),
    ).toEqual([
      ...PROJECT_FOLDERS.map((projectFolder) => ({
        sessionId: SESSION_A,
        projectFolder,
        revokeRecorded: false,
      })),
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

  it("records one revoke when two revokes of a rule come at once", async () => {
    const { stored: made } = await makeRule(SESSION_A, HOST, { kind: "session", sense: "allow" });

    const outcomes = await Promise.allSettled([
      rules.revoke(ruleIdOf(made)),
      rules.revoke(ruleIdOf(made)),
    ]);

    expect(outcomes.map((outcome) => outcome.status).toSorted()).toEqual(["fulfilled", "rejected"]);
    expect(readRevokeTriggers()).toHaveLength(1);
  });

  it("takes the project rules a purged session made out of every folder, then the others' rules", async () => {
    await makeRule(SESSION_A, HOST, { kind: "project", sense: "allow" });
    await makeRule(
      SESSION_A,
      { kind: "command", command: "npm test" },
      {
        kind: "session",
        sense: "allow",
      },
    );
    handovers = [];

    const handOutRules = await rules.withdrawProjectRules(SESSION_A);
    const allow = { kind: "project", sense: "allow", action: "network", subject: "example.com" };
    expect(handovers).toEqual(
      PROJECT_FOLDERS.map((projectFolder) => ({
        sessionId: SESSION_A,
        rule: allow,
        projectFolder,
        revokeRecorded: false,
      })),
    );
    handovers = [];
    await handOutRules();

    expect(handovers).toEqual([
      { sessionId: SESSION_B, rule: allow, projectFolder: undefined, revokeRecorded: false },
    ]);
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

  it("ends at its start the rules of a session that closed while the daemon was down", async () => {
    const { stored: own } = await makeRule(SESSION_A, HOST, { kind: "session", sense: "allow" });
    await database.writer.write([
      { sql: "UPDATE sessions SET state = 'closed' WHERE id = ?", bindings: [SESSION_A] },
    ]);

    rules.start();
    await rules.stop();

    expect(readRevokeTriggers()).toMatchObject([
      { ruleId: own.approvalRequestId, invalidationTrigger: "session_end" },
    ]);
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
