// `SessionEventSchema` builds each type's schema on first use instead of holding a Zod
// discriminated union over every registered variant. The oracle below is that union, built over
// the very same variant schemas, so any difference in what is accepted, what comes out or which
// issues are reported is the dispatcher's. The two schemas stacked on it are compared against the
// union carrying their very own checks, so a stacked refinement must run exactly when it did.
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  SESSION_EVENT_CATEGORY_BY_TYPE,
  SESSION_EVENT_TYPES,
  SESSION_EVENT_VARIANT_SCHEMAS,
  SessionEventSchema,
  type SessionEventVariantSchema,
} from "../session.js";
import { EVENT_ENVELOPE_SEQUENCE_MAX } from "../envelope.js";
import { McpGovernanceEventSchema } from "../../mcp/event.js";
import { DriverEventSchema } from "../../provider/driver/event.js";
import {
  SESSION_EVENT_PAYLOAD_SAMPLES,
  buildAssistantMessageEvent,
  buildAssistantThinkingUpdateEvent,
  buildEventCompactedEvent,
  buildSessionCreatedEvent,
  buildToolActivityEvent,
  type WireSessionEvent,
} from "./session.test-support.js";
import {
  BINDING_CHANGED_PAYLOAD,
  BINDING_CHANGE_FAILED_PAYLOAD,
} from "../../agent/__tests__/provider-binding.test-support.js";
import { buildMcpServerOauthCompletedEvent } from "../../mcp/__tests__/event.test-support.js";
import { RUN_QUEUED_CHILD_PAYLOAD } from "../../run/__tests__/queued.test-support.js";
import { GOAL_UPDATED_PAYLOAD_BASE } from "../../session/__tests__/goal.test-support.js";
import {
  WORKFLOW_GATE_RESOLVED_PAYLOAD,
  buildPhaseSuspendedEvent,
} from "../../workflow/run/step/__tests__/events.test-support.js";
import {
  REGISTERED_WORKTREE_EVENTS,
  buildWorktreeEvent,
} from "../../worktree/__tests__/lifecycle.test-support.js";
import { ORCHESTRATION_REJECTED_PAYLOAD } from "../../__tests__/orchestration.test-support.js";
import { PTY_CONTROL_TAKEN_PAYLOAD } from "../../__tests__/pty.test-support.js";
import { QUESTION_ASKED_ON_RUN_PAYLOAD } from "../../__tests__/question.test-support.js";
import { RELAY_PIN_REFUSED_PAYLOAD } from "../../__tests__/relay.test-support.js";

type RegisteredType = (typeof SESSION_EVENT_TYPES)[number];

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";

const resolveVariantSchema = (type: string): SessionEventVariantSchema => {
  const variantSchema = SESSION_EVENT_VARIANT_SCHEMAS.resolve(type);
  if (variantSchema === undefined) {
    throw new Error(`no variant schema is registered for ${type}`);
  }
  return variantSchema;
};

const oracleSchema = z.discriminatedUnion(
  "type",
  SESSION_EVENT_TYPES.map(resolveVariantSchema) as [
    SessionEventVariantSchema,
    ...SessionEventVariantSchema[],
  ],
);

// The union carrying the stacked schema's own check objects, so no refinement is restated here.
// The cast only re-widens the checks' input type, which the stacked schema's annotation erased.
const stackOnOracle = (stacked: z.ZodType): z.ZodType =>
  oracleSchema.check(
    ...((stacked._zod.def.checks ?? []) as z.core.$ZodCheck<z.output<typeof oracleSchema>>[]),
  );

const STACKED_SCHEMAS: ReadonlyArray<
  readonly [name: string, stacked: z.ZodType, oracle: z.ZodType]
> = [
  ["DriverEventSchema", DriverEventSchema, stackOnOracle(DriverEventSchema)],
  ["McpGovernanceEventSchema", McpGovernanceEventSchema, stackOnOracle(McpGovernanceEventSchema)],
];

// Options a caller may hand the outer parse; the variant must see them as the union's option does.
const CALLER_PARSE_OPTIONS = {
  reportInput: true,
  error: (issue: { readonly code?: string }) =>
    `refused by the caller's map: ${String(issue.code)}`,
};

// Whole valid events other contracts tests already build, by type.
const VALID_EVENT_BUILDERS: ReadonlyMap<string, () => WireSessionEvent> = new Map<
  string,
  () => WireSessionEvent
>([
  ["session.created", buildSessionCreatedEvent],
  ["assistant.message", buildAssistantMessageEvent],
  ["assistant.thinking_update", buildAssistantThinkingUpdateEvent],
  ["event.compacted", buildEventCompactedEvent],
  ["tool.invoked", () => buildToolActivityEvent("tool.invoked", 42)],
  ["tool.result", () => buildToolActivityEvent("tool.result", 43)],
  ["tool.error", () => buildToolActivityEvent("tool.error", 44)],
  ...REGISTERED_WORKTREE_EVENTS.map(
    ([type, state]) => [type, () => buildWorktreeEvent(type, state)] as const,
  ),
  ["mcp.server_oauth_completed", buildMcpServerOauthCompletedEvent],
  [
    "workflow.phase_suspended",
    () => buildPhaseSuspendedEvent({ waitCause: "account", providerAccountId: "acct-1" }),
  ],
]);

// Valid payloads, by type: the ones other contracts tests build, then the rest.
const VALID_PAYLOADS: ReadonlyMap<string, Readonly<Record<string, unknown>>> = new Map<
  string,
  Readonly<Record<string, unknown>>
>([
  ["relay.pin_refused", RELAY_PIN_REFUSED_PAYLOAD],
  ["run.queued", RUN_QUEUED_CHILD_PAYLOAD],
  ["orchestration.rejected", ORCHESTRATION_REJECTED_PAYLOAD],
  ["workflow.gate_resolved", WORKFLOW_GATE_RESOLVED_PAYLOAD],
  ["session.goal_updated", { ...GOAL_UPDATED_PAYLOAD_BASE, status: "usage-limited" }],
  ["question.asked", QUESTION_ASKED_ON_RUN_PAYLOAD],
  ["pty.control_changed", PTY_CONTROL_TAKEN_PAYLOAD],
  ["agent.provider_binding_changed", BINDING_CHANGED_PAYLOAD],
  ["agent.provider_binding_change_failed", BINDING_CHANGE_FAILED_PAYLOAD],
  ...SESSION_EVENT_PAYLOAD_SAMPLES,
]);

const buildValidEvent = (type: RegisteredType): Record<string, unknown> => {
  const build = VALID_EVENT_BUILDERS.get(type);
  if (build !== undefined) {
    return { ...build() };
  }
  const payload = VALID_PAYLOADS.get(type);
  if (payload === undefined) {
    throw new Error(`no valid sample of ${type}`);
  }
  return {
    id: "evt-0900",
    sessionId: SESSION_ID,
    sequence: 900,
    occurredAt: "2026-01-22T19:16:00.000Z",
    category: SESSION_EVENT_CATEGORY_BY_TYPE.get(type),
    type,
    actor: null,
    version: "1.0",
    payload: { ...payload },
  };
};

const withoutKey = (event: Record<string, unknown>, key: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(event).filter(([member]) => member !== key));

// JSON.parse makes `__proto__` an own data key, as the wire delivers it.
const withOwnProtoKey = (value: Record<string, unknown>): unknown => {
  const members = JSON.stringify(value).slice(1, -1);
  return JSON.parse(`{"__proto__":{"smuggled":true}${members === "" ? "" : ","}${members}}`);
};

// Each mutation of the valid event with whether it must be refused: those refusals are asserted
// outright too, because the oracle shares the variant schemas and so cannot catch a loosened one.
const buildRefusalCandidates = (
  type: RegisteredType,
  event: Record<string, unknown>,
): ReadonlyArray<readonly [label: string, input: unknown, isRefused: boolean]> => {
  const payload = event["payload"] as Record<string, unknown>;
  const ownCategory = SESSION_EVENT_CATEGORY_BY_TYPE.get(type);
  const otherCategory = ownCategory === "usage_telemetry" ? "run_lifecycle" : "usage_telemetry";
  return [
    ["an unknown payload key", { ...event, payload: { ...payload, unknownMember: true } }, false],
    ["an own __proto__ payload key", { ...event, payload: withOwnProtoKey(payload) }, false],
    ["an empty payload", { ...event, payload: {} }, false],
    ["another category", { ...event, category: otherCategory }, true],
    ["an unknown top-level key", { ...event, unknownMember: true }, true],
    ["an own __proto__ key", withOwnProtoKey(event), true],
    ["no payload", withoutKey(event, "payload"), true],
    ["no type", withoutKey(event, "type"), true],
    ["an unknown type", { ...event, type: "session.teleported" }, true],
    ["a numeric type", { ...event, type: 7 }, true],
    ["a sequence above the ceiling", { ...event, sequence: EVENT_ENVELOPE_SEQUENCE_MAX + 2 }, true],
    ["a negative sequence", { ...event, sequence: -1 }, true],
    ["null", null, true],
    ["undefined", undefined, true],
    ["a string", type, true],
    ["an array", [event], true],
  ];
};

const expectSameParse = (
  input: unknown,
  subject: z.ZodType,
  oracle: z.ZodType,
  options?: z.core.ParseContext<z.core.$ZodIssue>,
): void => {
  const subjectResult = subject.safeParse(input, options);
  const oracleResult = oracle.safeParse(input, options);
  expect(subjectResult.success).toBe(oracleResult.success);
  if (subjectResult.success && oracleResult.success) {
    expect(subjectResult.data).toStrictEqual(oracleResult.data);
  } else {
    expect(subjectResult.error?.issues).toStrictEqual(oracleResult.error?.issues);
  }
};

// Every schema pair, with and without the caller's options.
const expectSameParseEverywhere = (input: unknown): void => {
  for (const options of [undefined, CALLER_PARSE_OPTIONS]) {
    expectSameParse(input, SessionEventSchema, oracleSchema, options);
    for (const [, stacked, oracle] of STACKED_SCHEMAS) {
      expectSameParse(input, stacked, oracle, options);
    }
  }
};

describe("SessionEventSchema parses exactly as a discriminated union of its variants", () => {
  it.each(SESSION_EVENT_TYPES.map((type) => [type] as const))("%s", (type) => {
    const event = buildValidEvent(type);
    expect(SessionEventSchema.safeParse(event).success).toBe(true);
    const inputs: ReadonlyArray<readonly [string, unknown, boolean]> = [
      ["the valid event", event, false],
      ["the valid event off the wire", JSON.parse(JSON.stringify(event)) as unknown, false],
      ...buildRefusalCandidates(type, event),
    ];
    for (const [label, input, isRefused] of inputs) {
      try {
        expectSameParseEverywhere(input);
        if (isRefused) {
          expect(SessionEventSchema.safeParse(input).success).toBe(false);
        }
      } catch (error) {
        throw new Error(`${type} given ${label}`, { cause: error });
      }
    }
  });

  it("refuses a stream change whose event is absent, as the union does", () => {
    const changeOver = (eventSchema: z.ZodType) => z.object({ event: eventSchema }).strict();
    const absent = {};
    expectSameParse(absent, changeOver(SessionEventSchema), changeOver(oracleSchema));
    expect(changeOver(SessionEventSchema).safeParse(absent).success).toBe(false);
  });

  it.each(STACKED_SCHEMAS)(
    "%s still runs its refinement after a payload that fails only a refine",
    (_name, stacked, oracle) => {
      // A deleted range that ends before it starts fails a refine and nothing else, so the parse
      // goes on and the stacked check refuses the type too, outside both narrowed categories.
      const event = buildEventCompactedEvent();
      const reversedRange = {
        ...event,
        payload: {
          ...event.payload,
          removedSessions: [{ sessionId: SESSION_ID, fromSeq: 10, toSeq: 9 }],
        },
      };
      expectSameParse(reversedRange, stacked, oracle);
      expectSameParse(reversedRange, stacked, oracle, CALLER_PARSE_OPTIONS);
      const issuePaths = stacked.safeParse(reversedRange).error?.issues.map((issue) => issue.path);
      expect(issuePaths).toStrictEqual([["payload", "removedSessions", 0, "toSeq"], ["type"]]);
    },
  );
});
