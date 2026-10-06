// The event log's wire guards: what a stored event may carry is decided here, before it is
// written or read back, so a wrong row never reaches the log or a reader.
import { describe, expect, it } from "vitest";

import { SESSION_EVENT_CATEGORY_BY_TYPE, SessionEventSchema } from "../session-event.js";
import {
  DAEMON_SCOPE_SENTINEL_SESSION_ID,
  EventEnvelopeSchema,
  EventEnvelopeVersionSchema,
  compareEventEnvelopeVersion,
} from "../envelope.js";
import {
  buildAssistantMessageEvent,
  buildSessionCreatedEvent,
} from "./session-event.test-support.js";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const VERSION = "1.0";

describe("SessionEventSchema", () => {
  it("round-trips session.created through JSON without loss", () => {
    const label = "session.created";
    const original = buildSessionCreatedEvent();

    // Wire path: parse → JSON encode → JSON decode → parse again. The schema
    // must be JSON-stable: same shape in, same shape out, same parsed value.
    const firstPass = SessionEventSchema.parse(original);
    const onWire = JSON.stringify(firstPass);
    const offWire = JSON.parse(onWire) as unknown;
    const secondPass = SessionEventSchema.parse(offWire);

    expect(secondPass).toStrictEqual(firstPass);
    expect(secondPass.type).toBe(label);
  });

  it.each([["__proto__"], ["constructor"], ["toString"], ["hasOwnProperty"], ["unknown.event"]])(
    "SESSION_EVENT_CATEGORY_BY_TYPE.get rejects prototype-chain walks: %s",
    (untrusted) => {
      // Map (NOT object-literal) lookup is load-bearing: a reader that
      // calls `.get(evt.type)` on a not-yet-parsed string
      // MUST resolve to `undefined` for every key that isn't in the
      // explicit table, including built-in object prototype keys. With an
      // object literal `lookup['__proto__']` resolves to a truthy
      // `[Object: null prototype] {}` value.
      expect(SESSION_EVENT_CATEGORY_BY_TYPE.get(untrusted as never)).toBeUndefined();
    },
  );

  it("rejects a category/type mismatch (usage_telemetry on session.created)", () => {
    // Wire-integrity check: the per-variant `category: z.literal(...)`
    // forbids cross-namespace smuggling. If this ever silently accepted,
    // the log would store the event under the wrong category and a
    // rebuild would diverge.
    const broken = { ...buildSessionCreatedEvent(), category: "usage_telemetry" as const };
    const result = SessionEventSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it.each([
    ["id", "evt-\u0000-001"],
    ["actor", "alice\u0000bob"],
    ["correlationId", "req\u0000001"],
    ["causationId", "cause\u0000id"],
  ])("rejects NUL-byte %s value: %j", (field, value) => {
    const broken = { ...buildSessionCreatedEvent(), [field]: value };
    expect(SessionEventSchema.safeParse(broken).success).toBe(false);
  });
});

// compareEventEnvelopeVersion is a total ordering of the branded version type. Inputs go
// through `EventEnvelopeVersionSchema.parse` so each case exercises the real brand path, not an
// `as` cast.
//
// The multi-digit cases guard against a lexical compare: numeric ordering gives "10" > "9" and
// "1.10" > "1.9", lexical gives the opposite, which is why the comparator parses MAJOR and MINOR
// as integers. The precision cases guard against `Number`: within the schema's length cap, two
// distinct versions above `Number.MAX_SAFE_INTEGER` still collapse to one float, so the
// comparator parses with `BigInt` to keep the ordering exact.
describe("compareEventEnvelopeVersion", () => {
  const parseVersion = (raw: string) => EventEnvelopeVersionSchema.parse(raw);

  it.each([
    ["1.0", "1.0"],
    ["2.5", "2.5"],
  ])("returns 0 for equal versions: compare(%s, %s)", (left, right) => {
    expect(compareEventEnvelopeVersion(parseVersion(left), parseVersion(right))).toBe(0);
  });

  it.each([
    // [a, b, expected] — major equal, minor decides.
    ["1.2", "1.5", -1],
    ["1.5", "1.2", 1],
  ] as const)(
    "orders by MINOR when MAJOR is equal: compare(%s, %s) === %d",
    (left, right, want) => {
      expect(compareEventEnvelopeVersion(parseVersion(left), parseVersion(right))).toBe(want);
    },
  );

  it.each([
    // MAJOR dominates MINOR — 2.0 outranks 1.9 despite minor 0 < 9.
    ["2.0", "1.9", 1],
    ["1.9", "2.0", -1],
  ] as const)("MAJOR dominates MINOR: compare(%s, %s) === %d", (left, right, want) => {
    expect(compareEventEnvelopeVersion(parseVersion(left), parseVersion(right))).toBe(want);
  });

  it("multi-digit MAJOR is compared numerically, not lexically: compare(10.0, 9.0) === 1", () => {
    // Lexical string compare would give `"10" < "9"` (-> -1); numeric major
    // 10 > 9 gives 1.
    expect(compareEventEnvelopeVersion(parseVersion("10.0"), parseVersion("9.0"))).toBe(1);
  });

  it("multi-digit MINOR is compared numerically, not lexically: compare(1.10, 1.9) === 1", () => {
    // Lexical compare would give `"1.10" < "1.9"` (-> -1); numeric minor
    // 10 > 9 gives 1.
    expect(compareEventEnvelopeVersion(parseVersion("1.10"), parseVersion("1.9"))).toBe(1);
  });

  // Precision: BigInt compare is exact above Number.MAX_SAFE_INTEGER. A `Number` parse collapses
  // adjacent integers past 9007199254740991 to one float, so a below-floor client could be
  // mis-read as at-floor and granted read-write at the version-floor gate.

  it("orders adjacent MAJORs above Number.MAX_SAFE_INTEGER", () => {
    // Number("9007199254740993") === Number("9007199254740992") === 9007199254740992,
    // so a numeric compare returns 0; BigInt keeps them distinct -> 1 / -1.
    expect(
      compareEventEnvelopeVersion(
        parseVersion("9007199254740993.0"),
        parseVersion("9007199254740992.0"),
      ),
    ).toBe(1);
    expect(
      compareEventEnvelopeVersion(
        parseVersion("9007199254740992.0"),
        parseVersion("9007199254740993.0"),
      ),
    ).toBe(-1);
  });

  it("orders adjacent MINORs above Number.MAX_SAFE_INTEGER", () => {
    expect(
      compareEventEnvelopeVersion(
        parseVersion("1.9007199254740993"),
        parseVersion("1.9007199254740992"),
      ),
    ).toBe(1);
  });
});

// EventEnvelopeSchema is the version-tolerant carrier: `type` is a bounded free-form string, not
// the registered type union, and `payload` is an open record, so a reader keeps what a newer
// producer sends while `SessionEventSchema` stays the strict layer.

// A fully populated envelope; `actor` is present as null.
const buildBareEnvelope = () => ({
  id: "evt-0100",
  sessionId: SESSION_ID,
  sequence: 41,
  occurredAt: "2026-01-22T19:14:38.000Z",
  category: "usage_telemetry" as const,
  type: "usage.token_count",
  actor: null,
  payload: { runId: "run-001", totalTokens: 1234, providerExtra: { nested: true } },
  correlationId: "req-042",
  causationId: "evt-0099",
  version: VERSION,
});

describe("EventEnvelopeSchema — canonical carrier", () => {
  it("accepts a forward type this build has not registered", () => {
    // A reader must be able to parse the envelope of a type from a newer producer that this
    // build does not know, so it can persist a version stub; rejecting it would drop the events
    // the stub path exists to preserve. The literal is fictional, and the lookup below proves it
    // is unregistered.
    const forwardType = "session.teleported";
    expect(SESSION_EVENT_CATEGORY_BY_TYPE.get(forwardType as never)).toBeUndefined();
    const forward = {
      ...buildBareEnvelope(),
      category: "session_lifecycle" as const,
      type: forwardType,
      payload: { sessionId: SESSION_ID, destination: "elsewhere" },
    };
    expect(EventEnvelopeSchema.safeParse(forward).success).toBe(true);
    expect(SessionEventSchema.safeParse(forward).success).toBe(false);
  });

  it("rejects an own `__proto__` payload key (JSON.parse-built wire member)", () => {
    // JSON.parse defines `__proto__` as an own data property, so the wire really carries the
    // member (an object literal `{ __proto__: ... }` would set the prototype and never reach the
    // parser with an own key). Zod's record parser skips own `__proto__` keys, so preserving it
    // is impossible and the default outcome is a silent drop: two distinct wire byte-strings
    // would collapse to one parse output. The payload pre-guard (a raw check before the record
    // parser; a refine on the record's output could never see the dropped key) rejects it
    // loudly.
    const protoPayload = JSON.parse('{"__proto__":{"smuggled":true},"totalTokens":1}') as unknown;
    // Fixture self-check: the parsed JSON really carries an OWN key (an
    // `in` check would be satisfied by the prototype chain and prove
    // nothing).
    expect(Object.hasOwn(protoPayload as object, "__proto__")).toBe(true);
    const broken = { ...buildBareEnvelope(), payload: protoPayload };
    expect(EventEnvelopeSchema.safeParse(broken).success).toBe(false);
  });

  it.each([["unknownForwardField"], ["constructor"], ["prototype"]])(
    "preserves unknown payload key %s verbatim (guard positive control)",
    (unknownKey) => {
      // The carve-out is exactly one key wide: every other unknown payload key, including the
      // proto-adjacent `constructor` and `prototype` (preservable own data keys), still
      // round-trips untouched. Zod's record-parser skip-list is `__proto__`-only today, so the
      // pre-guard is co-extensive with the drop; if an upgrade widens that list, this must fail
      // first.
      const parsed = EventEnvelopeSchema.parse({
        ...buildBareEnvelope(),
        payload: { [unknownKey]: { marker: unknownKey } },
      });
      expect(Object.keys(parsed.payload)).toEqual([unknownKey]);
      expect(parsed.payload[unknownKey]).toStrictEqual({ marker: unknownKey });
    },
  );
});

// The event_maintenance payload variant (`event.compacted`). The daemon emits it itself, so its
// payload schema is authored in event/declared-variants.ts rather than imported from an emitting
// contract.
// Coverage is at the variant level (through `SessionEventSchema`): a payload-only suite would
// stay green if an arm were never registered in the union.

const NODE_ID = "node-7f3a2c";

const buildEventCompacted = () => ({
  id: "evt-0105",
  sessionId: DAEMON_SCOPE_SENTINEL_SESSION_ID,
  sequence: 105,
  occurredAt: "2026-01-22T19:14:40.000Z",
  category: "event_maintenance" as const,
  type: "event.compacted" as const,
  actor: null,
  version: VERSION,
  payload: {
    nodeId: NODE_ID,
    operationId: "compact-2026-01-22-01",
    occurredAt: "2026-01-22T19:14:40.000Z",
    removedSessions: [{ sessionId: SESSION_ID, fromSeq: 1, toSeq: 4096 }],
  },
});

const SESSION_EVENT_VARIANTS = [["event.compacted", buildEventCompacted]] as const;

describe("event_maintenance payload variant", () => {
  it.each(SESSION_EVENT_VARIANTS)("round-trips %s through JSON without loss", (_label, build) => {
    const original = build();
    const firstPass = SessionEventSchema.parse(original);
    const offWire = JSON.parse(JSON.stringify(firstPass)) as unknown;
    expect(SessionEventSchema.parse(offWire)).toStrictEqual(firstPass);
    // No key added (no `.default()`), none dropped (`.strict()`, no stripping)
    // — parse output ≡ wire bytes, the canonical-bytes precondition.
    expect(firstPass).toStrictEqual(original);
  });

  it("event.compacted refuses a deleted range that ends before it starts", () => {
    const event = buildEventCompacted();
    expect(
      SessionEventSchema.safeParse({
        ...event,
        payload: {
          ...event.payload,
          removedSessions: [{ sessionId: SESSION_ID, fromSeq: 10, toSeq: 9 }],
        },
      }).success,
    ).toBe(false);
  });
});

// The five body-bearing assistant and tool payload variants. The body is sealed apart from the
// payload, so no payload may carry it.

const RUN_ID = "990e8400-e29b-41d4-a716-446655440004";

const buildAssistantThinkingUpdate = () => ({
  id: "evt-3602",
  sessionId: SESSION_ID,
  sequence: 41,
  occurredAt: "2026-01-22T19:15:02.000Z",
  category: "assistant_output" as const,
  type: "assistant.thinking_update" as const,
  actor: null,
  version: VERSION,
  payload: {
    sessionId: SESSION_ID,
    runId: RUN_ID,
    contentLength: 128,
  },
});

const buildToolRow = (type: "tool.invoked" | "tool.result" | "tool.error", sequence: number) => ({
  id: `evt-36${String(sequence)}`,
  sessionId: SESSION_ID,
  sequence,
  occurredAt: "2026-01-22T19:15:03.000Z",
  category: "tool_activity" as const,
  type,
  actor: null,
  version: VERSION,
  payload: {
    sessionId: SESSION_ID,
    runId: RUN_ID,
    toolName: "Bash",
    toolCallId: "call-0001",
    durationMs: 1200,
    contentLength: 262_145,
    contentTruncated: true as const,
  },
});

const BODY_BEARING_VARIANTS = [
  ["assistant.message", buildAssistantMessageEvent],
  ["assistant.thinking_update", buildAssistantThinkingUpdate],
  ["tool.invoked", () => buildToolRow("tool.invoked", 42)],
  ["tool.result", () => buildToolRow("tool.result", 43)],
  ["tool.error", () => buildToolRow("tool.error", 44)],
] as const;

describe("SessionEventSchema — body-bearing assistant / tool variants", () => {
  it("files an assistant row under a run unless it is a voice call's answer", () => {
    const event = buildAssistantMessageEvent();
    const { runId: _runId, ...outsideAnyRun } = event.payload;
    const withPayload = (payload: Record<string, unknown>) => ({ ...event, payload });
    expect(
      SessionEventSchema.safeParse(withPayload({ ...outsideAnyRun, origin: "voice" })).success,
    ).toBe(true);
    // An answer with no run and no voice mark has lost its run; a voice answer filed under a
    // run would draw outside the spoken exchange it belongs to.
    expect(SessionEventSchema.safeParse(withPayload(outsideAnyRun)).success).toBe(false);
    expect(
      SessionEventSchema.safeParse(withPayload({ ...event.payload, origin: "voice" })).success,
    ).toBe(false);
  });

  it.each(BODY_BEARING_VARIANTS)("round-trips %s through JSON without loss", (_type, build) => {
    const event = build();
    const parsed = SessionEventSchema.safeParse(JSON.parse(JSON.stringify(event)));
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual(event);
  });

  it.each(BODY_BEARING_VARIANTS)(
    "%s carries the descriptive members but NEVER a body member",
    (_type, build) => {
      const event = build();
      // The whole point of the column: the prose is not in the payload, so no
      // amount of schema growth here may quietly reintroduce it.
      for (const bodyKey of ["body", "content", "text", "result", "arguments"]) {
        const smuggled = { ...event, payload: { ...event.payload, [bodyKey]: "the prose" } };
        expect(SessionEventSchema.safeParse(smuggled).success).toBe(false);
      }
    },
  );
});
