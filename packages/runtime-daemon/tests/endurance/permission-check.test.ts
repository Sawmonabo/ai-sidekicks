// Tier: endurance. The permission check's cost per decision, through the composed check over the
// built-in rules held resident, a real rules store and a real log on a scratch database: a workflow
// start the rules allow and one a rule over the asking run's posture refuses, each a full
// evaluation; and a provider's ask the daemon answers itself, one a rule in force answers, and one
// that raises its card, a durable write. It prints p50, p95 and p99 per class against its p95
// budget, fails on any class over one, and proves every start was evaluated afresh, none served
// from a cache.

import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ExecutionPosture } from "@ai-sidekicks/contracts/provider/driver/capabilities";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { NodeId } from "@ai-sidekicks/contracts/runtime-node/id";
import type { SessionId, UserId } from "@ai-sidekicks/contracts/session/id";
import type { DeviceId } from "@ai-sidekicks/contracts/trust-statement";
import type { WorkflowDefinitionId } from "@ai-sidekicks/contracts/workflow/definition/document";

import { HOST_OPERATING_SYSTEM } from "../helpers/host-operating-system.js";
import { describeProviderAsk } from "../../src/approvals/ask-description.js";
import { ApprovalRules } from "../../src/approvals/rules.js";
import { ApprovalService } from "../../src/approvals/service.js";
import {
  openScratchDatabase,
  type ScratchDatabase,
} from "../../src/database/__fixtures__/scratch.js";
import { EventLogService } from "../../src/events/log-service.js";
import { loadAuthorizer } from "../../src/policy/authorizer.js";
import {
  PermissionCheckService,
  type PermissionCheckResponse,
} from "../../src/policy/permission-check.js";
import type { ProviderPermissionAsk } from "../../src/provider/port/permission-ask.js";
import { timingOf, type Timing } from "./timing.js";

// A workflow start's decision by the rules, marshaling into and out of the engine included: the
// rules engine's own 1 ms target for one decision.
const RULES_P95_BUDGET_MS = 1;
// A provider's ask the daemon answers, by its own answer or a rule in force: the 10 ms of the
// daemon's time one answer may cost.
const ANSWER_P95_BUDGET_MS = 10;
// A provider's ask that raises its card, a durable write: the log's 10 ms target for one append.
const CARD_P95_BUDGET_MS = 10;

// Untimed checks first, so the engine and the statements are warm; then the timed ones.
const WARMUP_CHECKS = 100;
const TIMED_CHECKS = 1_000;

const SESSION_ID = "00000000-0000-7000-8000-000000000001" as SessionId;
const RUN_ID = "00000000-0000-7000-8000-0000000000b1" as RunId;
const OWNER = "user-1" as UserId;
const WORKFLOW_ID = "workflow-1" as WorkflowDefinitionId;
const CREATED_AT = "2026-10-11T00:00:00.000Z";
const BUILT_IN_RULES_FOLDER = fileURLToPath(new URL("../../src/policy/rules/", import.meta.url));

function postureAt(mode: ExecutionPosture["mode"]): ExecutionPosture {
  return { mode, writableRoots: [], credentialPolicyRef: "curated-credentials" };
}

function commandAsk(command: string, requestId: string): ProviderPermissionAsk {
  return {
    sessionId: SESSION_ID,
    runId: RUN_ID,
    requestId,
    toolName: "Bash",
    input: { command },
    action: { kind: "command", command },
    ruleScopes: ["session", "project"],
    isProviderFlagged: false,
  };
}

let scratchFolder: string;
let database: ScratchDatabase;
let check: PermissionCheckService;
let posture: ExecutionPosture;
let evaluations: number;
let memoryNotePath: string;

beforeAll(async () => {
  scratchFolder = await mkdtemp(path.join(tmpdir(), "permission-check-endurance-"));
  // The built-in rules, plus one refusing a start asked for from a run at Read-only.
  const rulesFolder = path.join(scratchFolder, "rules");
  await mkdir(rulesFolder);
  for (const fileName of ["schema.cedarschema", "workflow.cedar"]) {
    await copyFile(path.join(BUILT_IN_RULES_FOLDER, fileName), path.join(rulesFolder, fileName));
  }
  await writeFile(
    path.join(rulesFolder, "read-only.cedar"),
    `forbid (principal, action == Action::"workflow::start", resource)
       when { context has posture && context.posture.mode == "readonly" };`,
  );
  const memoryFolder = path.join(scratchFolder, "agent-memory");
  await mkdir(path.join(memoryFolder, "reviewer"), { recursive: true });
  memoryNotePath = path.join(memoryFolder, "reviewer", "MEMORY.md");
  await writeFile(memoryNotePath, "# Notes\n");

  database = await openScratchDatabase();
  await database.writer.write([
    {
      sql: `INSERT INTO sessions (id, shape, state, created_at, updated_at, last_activity_at)
            VALUES (?, 'project', 'active', ?, ?, ?)`,
      bindings: [SESSION_ID, CREATED_AT, CREATED_AT, CREATED_AT],
    },
    {
      sql: "INSERT INTO runs (run_id, session_id, state, run_version) VALUES (?, ?, 'running', 1)",
      bindings: [RUN_ID, SESSION_ID],
    },
  ]);
  const writeServiceLog = (line: string): void => {
    throw new Error(`unexpected service log line: ${line}`);
  };
  const sessionEvents = new EventLogService({
    writer: database.writer,
    reader: database.reader,
    writeServiceLog,
  });
  const approvals = new ApprovalService({
    reader: database.reader,
    writer: database.writer,
    sessionEvents,
    followAll: () => () => {},
    workingFolders: { raiseStaleness: async () => {} },
    writeServiceLog,
  });
  const rules = new ApprovalRules({
    reader: database.reader,
    sessionEvents,
    nodeId: "node-local" as NodeId,
    followAll: () => () => {},
    revokeAtProvider: async () => {},
    writeServiceLog,
  });
  // The session's own allow over `npm test`, made by a person's answer.
  const { approvalRequestId } = await approvals.create(
    {
      sessionId: SESSION_ID,
      runId: RUN_ID,
      requestedBy: "agent-1",
      ...describeProviderAsk(commandAsk("npm test", "rule")),
    },
    { askId: "ask-rule" },
  );
  await approvals.resolve(
    {
      approvalRequestId,
      decision: "approved",
      clientResolutionId: "00000000-0000-4000-8000-0000000000d1",
    },
    "device-laptop" as DeviceId,
  );
  const answered = approvals.readRequest(approvalRequestId);
  if (answered === undefined) {
    throw new Error(`no request ${approvalRequestId}`);
  }
  await rules.record(answered, {
    rule: { kind: "session", sense: "allow", action: "command", subject: "npm test" },
    projectFolders: [],
  });

  const authorizer = await loadAuthorizer(rulesFolder);
  evaluations = 0;
  posture = postureAt("ask");
  check = new PermissionCheckService({
    authorizer: {
      decide: (request) => {
        evaluations += 1;
        return authorizer.decide(request);
      },
    },
    approvals,
    rules,
    agentMemoryFolder: memoryFolder,
    pathRules: HOST_OPERATING_SYSTEM.pathRules,
    readRunAgent: () => "agent-1",
    readOwner: () => OWNER,
    readPosture: () => posture,
  });
});

afterAll(async () => {
  await database.close();
  await rm(scratchFolder, { recursive: true, force: true });
});

// Runs `decide` for the warmup and then the timed checks, each answer checked against `expected`.
async function measure(
  decide: (index: number) => Promise<PermissionCheckResponse>,
  expected: PermissionCheckResponse["reason"],
): Promise<Timing & { worstMs: number }> {
  const durationsMs: number[] = [];
  for (let index = 0; index < WARMUP_CHECKS + TIMED_CHECKS; index += 1) {
    const startedAt = performance.now();
    const answer = await decide(index);
    const elapsedMs = performance.now() - startedAt;
    if (answer.reason !== expected) {
      throw new Error(`check ${String(index)} answered ${answer.reason}, not ${expected}`);
    }
    if (index >= WARMUP_CHECKS) {
      durationsMs.push(elapsedMs);
    }
  }
  return { ...timingOf(durationsMs), worstMs: Math.max(...durationsMs) };
}

describe("the permission check's cost per decision", () => {
  it("decides each class within its budget, evaluating every start afresh", async () => {
    const start = { kind: "workflow_start", workflowId: WORKFLOW_ID, askingRunId: RUN_ID } as const;
    const signal = new AbortController().signal;
    const classes: { label: string; budgetMs: number; timing: Timing & { worstMs: number } }[] = [];

    posture = postureAt("ask");
    classes.push({
      label: "workflow start, allowed",
      budgetMs: RULES_P95_BUDGET_MS,
      timing: await measure(() => check.check(start), "policy_allow"),
    });
    posture = postureAt("readonly");
    classes.push({
      label: "workflow start, refused",
      budgetMs: RULES_P95_BUDGET_MS,
      timing: await measure(() => check.check(start), "denied"),
    });
    // Every start check, identical ones back to back included, reached the rules.
    expect(evaluations).toBe(2 * (WARMUP_CHECKS + TIMED_CHECKS));

    classes.push({
      label: "provider ask, the daemon's own answer",
      budgetMs: ANSWER_P95_BUDGET_MS,
      timing: await measure(
        (index) =>
          check.check({
            kind: "provider_ask",
            ask: {
              ...commandAsk("unused", `note-${String(index)}`),
              toolName: "Edit",
              action: { kind: "file_change", paths: [memoryNotePath] },
            },
            askId: `note-${String(index)}`,
            signal,
          }),
        "policy_allow",
      ),
    });
    classes.push({
      label: "provider ask, a rule in force",
      budgetMs: ANSWER_P95_BUDGET_MS,
      timing: await measure(
        (index) =>
          check.check({
            kind: "provider_ask",
            ask: commandAsk("npm test", `rule-${String(index)}`),
            askId: `rule-${String(index)}`,
            signal,
          }),
        "remembered_rule",
      ),
    });
    classes.push({
      label: "provider ask, a card raised",
      budgetMs: CARD_P95_BUDGET_MS,
      timing: await measure(
        (index) =>
          check.check({
            kind: "provider_ask",
            ask: commandAsk("npm run build", `card-${String(index)}`),
            askId: `card-${String(index)}`,
            signal,
          }),
        "pending_approval",
      ),
    });

    console.info(
      [
        `Permission check, ${String(TIMED_CHECKS)} timed checks per class (p50/p95/p99, worst):`,
        ...classes.map(
          ({ label, budgetMs, timing }) =>
            `  ${label}: ${timing.p50Ms.toFixed(3)}/${timing.p95Ms.toFixed(3)}/` +
            `${timing.p99Ms.toFixed(3)} ms, worst ${timing.worstMs.toFixed(3)} ms; ` +
            `budget ${String(budgetMs)} ms at p95`,
        ),
      ].join("\n"),
    );
    expect(
      classes.filter(({ budgetMs, timing }) => timing.p95Ms > budgetMs).map(({ label }) => label),
    ).toEqual([]);
  });
});
