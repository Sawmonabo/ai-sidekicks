// The intake of provider asks: an ask the daemon answers itself goes straight back with no card,
// while a destructive git command, an ask the provider's own check flagged and an ask a rule never
// named still reach the card; an ask delivered again while held raises one card, and its request
// id once settled a new one; an ask its provider takes back while its card is being raised is
// canceled once it is; a card's answer reaches the provider once, decision first with the rule it
// made, which is recorded once the provider kept it and never when it could not.

import { afterEach, beforeEach, expect, it } from "vitest";

import type { ApprovalResolveRequest } from "@ai-sidekicks/contracts/approval";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { DeviceId } from "@ai-sidekicks/contracts/trust-statement";

import { openScratchDatabase, type ScratchDatabase } from "../../database/__fixtures__/scratch.js";
import { EventLogService } from "../../events/log-service.js";
import type { RespondToRequestParams } from "../../provider/driver/contract.js";
import {
  ProviderRuleNotKeptError,
  type ProviderAnswerRule,
  type ProviderAskRule,
  type ProviderPermissionAnswer,
  type ProviderPermissionAsk,
} from "../../provider/port/permission-ask.js";
import { PermissionAsks } from "../permission-asks.js";
import type { ApprovalRules } from "../rules.js";
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
  isProviderFlagged: false,
};
const PROJECT_FOLDERS = ["/work/repo", "/work/repo-feature"];
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
let providerFailure: Error | undefined;
let recorded: { made: ProviderAnswerRule; afterAnswers: number }[];
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
  providerFailure = undefined;
  recorded = [];
  createGate = undefined;
  onCreate = () => {};
});

afterEach(async () => {
  await database.close();
});

function buildAsks(): PermissionAsks {
  const rules: Pick<ApprovalRules, "findRule" | "record" | "readProjectFolders"> = {
    findRule: (_sessionId, action, subject) =>
      rulesInForce.find((rule) => rule.action === action && rule.subject === subject),
    record: async (_request, made) => {
      if (recordFailure !== undefined) {
        throw recordFailure;
      }
      recorded.push({ made, afterAnswers: responses.length });
    },
    readProjectFolders: () => PROJECT_FOLDERS,
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
      if (providerFailure !== undefined) {
        throw providerFailure;
      }
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
  kind: "session" | "project" = "session",
): ApprovalResolveRequest {
  return {
    approvalRequestId,
    decision: "approved",
    clientResolutionId,
    rememberedScope: { kind, sense: "allow", pattern: "npm test" },
  } as ApprovalResolveRequest;
}

it("answers itself, with no card, a background command and an ask a rule in force covers", async () => {
  const asks = buildAsks();
  rulesInForce = [NPM_TEST_RULE, { ...NPM_TEST_RULE, sense: "block", subject: "npm publish" }];

  await asks.takeAsk({ ...NPM_TEST, action: { kind: "command", command: "claude --bg fix" } });
  await asks.takeAsk(NPM_TEST);
  await asks.takeAsk({ ...NPM_TEST, action: { kind: "command", command: "npm publish" } });

  expect(responses.map(({ response }) => (response as ProviderPermissionAnswer).decision)).toEqual([
    "refuse",
    "allow",
    "refuse",
  ]);
  expect(readCards()).toEqual([]);
});

it("answers a block in force itself on an ask that offers no rule", async () => {
  const asks = buildAsks();
  rulesInForce = [{ kind: "session", sense: "block", action: "network", subject: "evil.test" }];

  await asks.takeAsk({
    ...NPM_TEST,
    action: { kind: "network", host: "evil.test" },
    ruleScopes: [],
  });

  expect(responses).toMatchObject([{ response: { decision: "refuse" } }]);
  expect(readCards()).toEqual([]);
});

it.each([
  ["a force push under an allow on its subject", "git push --force origin main", "git push", false],
  ["a destructive push behind git's own options", "git -C . push -f", "git push", false],
  ["a removal the provider's own check flagged", "rm -rf ./*", "rm", true],
])("brings %s to the card", async (_case, command, subject, isProviderFlagged) => {
  const asks = buildAsks();
  rulesInForce = [{ ...NPM_TEST_RULE, subject }];

  await asks.takeAsk({ ...NPM_TEST, action: { kind: "command", command }, isProviderFlagged });

  expect(responses).toEqual([]);
  expect(readCards()).toMatchObject([{ state: "pending" }]);
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

it("hands the provider the answer and its rule once, then records the rule it kept", async () => {
  const asks = buildAsks();
  await asks.takeAsk(NPM_TEST);
  const [card] = readCards();
  const answer = approveAlways(card?.id ?? "", "00000000-0000-4000-8000-0000000000d1", "project");
  const madeRule = { rule: { ...NPM_TEST_RULE, kind: "project" }, projectFolders: PROJECT_FOLDERS };

  await asks.resolve(answer, LAPTOP);
  await asks.resolve(answer, LAPTOP);

  expect(responses).toEqual([
    { runId: RUN_ID, requestId: "7", response: { decision: "allow", madeRule } },
  ]);
  expect(recorded).toEqual([{ made: madeRule, afterAnswers: 1 }]);
});

it("records no rule its provider could not keep, and says so with the call answered", async () => {
  const asks = buildAsks();
  providerFailure = new ProviderRuleNotKeptError(new Error("settings file is not writable"));
  await asks.takeAsk(NPM_TEST);
  const [card] = readCards();

  await expect(
    asks.resolve(approveAlways(card?.id ?? "", "00000000-0000-4000-8000-0000000000d1"), LAPTOP),
  ).rejects.toMatchObject({ code: "approval.rule_not_kept" });

  expect(responses).toMatchObject([{ response: { decision: "allow" } }]);
  expect(recorded).toEqual([]);
  expect(readCards()).toMatchObject([{ state: "approved" }]);
});

it("throws what the record threw once the provider kept the rule, with the answer kept", async () => {
  const asks = buildAsks();
  recordFailure = new Error("the log is full");
  await asks.takeAsk(NPM_TEST);
  const [card] = readCards();

  await expect(
    asks.resolve(approveAlways(card?.id ?? "", "00000000-0000-4000-8000-0000000000d1"), LAPTOP),
  ).rejects.toThrow("the log is full");

  expect(responses).toMatchObject([{ response: { decision: "allow" } }]);
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
