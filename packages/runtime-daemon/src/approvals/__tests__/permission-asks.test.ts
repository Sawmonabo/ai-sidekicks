// The intake of provider asks: an ask the daemon answers itself goes straight back with no card;
// an ask delivered again while held raises one card, and its request id once settled a new one;
// an ask its provider takes back while its card is being raised is canceled once it is; a card's
// answer reaches the provider once, with the rule it made, even when that rule could not be
// recorded; and the sessions a replaced rule reached read their rules again after the answer.

import { afterEach, beforeEach, expect, it } from "vitest";

import type { ApprovalResolveRequest } from "@ai-sidekicks/contracts/approval";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { DeviceId } from "@ai-sidekicks/contracts/trust-statement";

import { openScratchDatabase, type ScratchDatabase } from "../../database/__fixtures__/scratch.js";
import { EventLogService } from "../../events/log-service.js";
import type { RespondToRequestParams } from "../../provider/driver/contract.js";
import type { ProviderAskRule, ProviderPermissionAsk } from "../../provider/port/permission-ask.js";
import { PermissionAsks } from "../permission-asks.js";
import type { ApprovalRules, RecordedRule } from "../rules.js";
import { ApprovalService } from "../service.js";

const SESSION_ID = "00000000-0000-7000-8000-000000000001" as SessionId;
const RUN_ID = "00000000-0000-7000-8000-0000000000b1" as RunId;
const LAPTOP = "device-laptop" as DeviceId;
const CREATED_AT = "2026-10-11T00:00:00.000Z";
const NPM_TEST: ProviderPermissionAsk = {
  sessionId: SESSION_ID,
  runId: RUN_ID,
  requestId: "7",
  toolCallId: "call-1",
  toolName: "Bash",
  input: { command: "npm test" },
  action: { kind: "command", command: "npm test" },
  ruleScopes: ["session", "project"],
};
const NPM_TEST_RULE: ProviderAskRule = {
  kind: "session",
  sense: "allow",
  action: "command",
  subject: "npm test",
};

let database: ScratchDatabase;
let service: ApprovalService;
let responses: RespondToRequestParams[];
let rulesInForce: ProviderAskRule[];
let recordFailure: Error | undefined;
let replacedRules: ProviderAskRule[];
let handedOut: { sessionId: SessionId; rules: readonly ProviderAskRule[]; afterAnswers: number }[];
// Holds a card's raising until the test lets it go, when set, after telling the test it began.
let createGate: Promise<void> | undefined;
let onCreate: () => void;

beforeEach(async () => {
  database = await openScratchDatabase();
  await database.writer.write([
    {
      sql: `INSERT INTO sessions (id, shape, state, created_at, updated_at, last_activity_at)
            VALUES (?, 'project', 'active', ?, ?, ?)`,
      bindings: [SESSION_ID, CREATED_AT, CREATED_AT, CREATED_AT],
    },
    {
      sql: `INSERT INTO runs (run_id, session_id, state, run_version) VALUES (?, ?, 'running', 1)`,
      bindings: [RUN_ID, SESSION_ID],
    },
  ]);
  service = new ApprovalService({
    reader: database.reader,
    sessionEvents: new EventLogService({
      writer: database.writer,
      reader: database.reader,
      writeServiceLog: (line) => {
        throw new Error(`unexpected service log line: ${line}`);
      },
    }),
    followAll: () => () => {},
    workingFolders: { raiseStaleness: async () => {} },
    writeServiceLog: (line) => {
      throw new Error(`unexpected service log line: ${line}`);
    },
  });
  responses = [];
  rulesInForce = [];
  recordFailure = undefined;
  replacedRules = [];
  handedOut = [];
  createGate = undefined;
  onCreate = () => {};
});

afterEach(async () => {
  await database.close();
});

function buildAsks(): PermissionAsks {
  const rules: Pick<ApprovalRules, "findRule" | "record" | "handOutRules"> = {
    findRule: (_sessionId, action, subject) =>
      rulesInForce.find((rule) => rule.action === action && rule.subject === subject),
    record: async (_request, action, scope): Promise<RecordedRule> => {
      if (recordFailure !== undefined) {
        throw recordFailure;
      }
      return {
        rule: { kind: scope.kind, sense: scope.sense, action, subject: scope.pattern },
        replaced: replacedRules,
      };
    },
    handOutRules: async (sessionId, handed) => {
      handedOut.push({ sessionId, rules: handed, afterAnswers: responses.length });
    },
  };
  return new PermissionAsks({
    approvals: {
      create: async (request, origin) => {
        onCreate();
        await createGate;
        return await service.create(request, origin);
      },
      resolve: service.resolve.bind(service),
      withdraw: service.withdraw.bind(service),
      readRequest: service.readRequest.bind(service),
      readAskRequest: service.readAskRequest.bind(service),
    },
    rules,
    agentMemoryFolder: "/data/agent-memory",
    readRunAgent: () => "agent-1",
    respondToRequest: async (params) => {
      responses.push(params);
    },
  });
}

function readCards(): { id: string; state: string; ask_id: string | null }[] {
  return database.reader
    .prepare<
      [],
      { id: string; state: string; ask_id: string | null }
    >("SELECT id, state, ask_id FROM approval_requests")
    .all();
}

function approveAlways(
  approvalRequestId: string,
  clientResolutionId: string,
): ApprovalResolveRequest {
  return {
    approvalRequestId,
    decision: "approved",
    clientResolutionId,
    rememberedScope: { kind: "session", sense: "allow", pattern: "npm test" },
  } as ApprovalResolveRequest;
}

it("answers itself, with no card, a background command and an ask a rule in force covers", async () => {
  const asks = buildAsks();
  rulesInForce = [NPM_TEST_RULE, { ...NPM_TEST_RULE, sense: "block", subject: "npm publish" }];

  await asks.takeAsk({ ...NPM_TEST, action: { kind: "command", command: "claude --bg fix" } });
  await asks.takeAsk(NPM_TEST);
  await asks.takeAsk({ ...NPM_TEST, action: { kind: "command", command: "npm publish" } });

  expect(responses.map(({ response }) => response.decision)).toEqual(["refuse", "allow", "refuse"]);
  expect(readCards()).toEqual([]);
});

it("raises no card, or cancels the card, of an ask its provider took back meanwhile", async () => {
  const asks = buildAsks();
  let releaseCreate = (): void => {};
  createGate = new Promise((resolve) => {
    releaseCreate = resolve;
  });
  const createStarted = new Promise<void>((resolve) => {
    onCreate = resolve;
  });

  // Taken back while it is read: no card, and no answer.
  const firstTaking = asks.takeAsk({ ...NPM_TEST, requestId: "6" });
  await asks.withdrawAsk({ sessionId: SESSION_ID, requestId: "6" });
  await firstTaking;
  // Taken back while its card is raised: the card is canceled once it stands.
  const secondTaking = asks.takeAsk(NPM_TEST);
  await createStarted;
  await asks.withdrawAsk({ sessionId: SESSION_ID, requestId: NPM_TEST.requestId });
  releaseCreate();
  await secondTaking;

  expect(readCards()).toMatchObject([{ state: "canceled" }]);
  expect(responses).toEqual([]);
  expect(service.hasPendingForRun(RUN_ID)).toBe(false);
});

it("hands the answer and its rule to the provider once, then the replaced rule's sessions", async () => {
  const asks = buildAsks();
  replacedRules = [{ ...NPM_TEST_RULE, kind: "project", sense: "block" }];
  await asks.takeAsk(NPM_TEST);
  const [card] = readCards();
  const answer = approveAlways(card?.id ?? "", "00000000-0000-4000-8000-0000000000d1");

  await asks.resolve(answer, LAPTOP);
  await asks.resolve(answer, LAPTOP);

  expect(responses).toEqual([
    { runId: RUN_ID, requestId: "7", response: { decision: "allow", rule: NPM_TEST_RULE } },
  ]);
  expect(handedOut).toEqual([{ sessionId: SESSION_ID, rules: replacedRules, afterAnswers: 1 }]);
});

it("answers the call without its rule when the rule could not be recorded, and says so", async () => {
  const asks = buildAsks();
  recordFailure = new Error("the log is full");
  await asks.takeAsk(NPM_TEST);
  const [card] = readCards();

  await expect(
    asks.resolve(approveAlways(card?.id ?? "", "00000000-0000-4000-8000-0000000000d1"), LAPTOP),
  ).rejects.toThrow("the log is full");

  expect(responses).toEqual([{ runId: RUN_ID, requestId: "7", response: { decision: "allow" } }]);
  expect(readCards()).toMatchObject([{ state: "approved" }]);
});

it("raises one card for an ask delivered again while held, and a new one once it is settled", async () => {
  const asks = buildAsks();

  await asks.takeAsk(NPM_TEST);
  await asks.takeAsk(NPM_TEST);
  const [first] = readCards();
  await asks.resolve(
    approveAlways(first?.id ?? "", "00000000-0000-4000-8000-0000000000d1"),
    LAPTOP,
  );
  // A provider that numbers its asks afresh after a restart sends the same request id again.
  await asks.takeAsk(NPM_TEST);

  const cards = readCards();
  expect(cards.map((card) => card.state)).toEqual(["approved", "pending"]);
  expect(new Set(cards.map((card) => card.ask_id)).size).toBe(2);
});
