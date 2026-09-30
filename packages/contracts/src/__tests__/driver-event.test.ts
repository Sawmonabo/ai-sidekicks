// DriverEvent: the driver-runtime slice of the census.
//
// `driver.subscribeEvents` streams one run's driver activity. The daemon
// handler filters on `DRIVER_EVENT_TYPES` before buffering and the client SDK
// validates every delivered frame against `DriverEventSchema`; both read the
// derivation authored in `../driver-event.js`, which is what makes a single
// home a single home rather than two copies that agree today.
//
// Three binds, because the cluster has three failure surfaces:
//   • The SET must be the census filtered to the seven categories. Asserted
//     through the REGISTRY, not by re-spreading the same seven arrays the
//     export spreads — re-running a derivation asserts nothing about it.
//   • The TYPE side has no runtime footprint at all, so a typo in the
//     category list would silently narrow `DriverEvent` while every runtime
//     assertion here still passed. It is pinned with a typed fixture whose
//     ELEMENT TYPE is load-bearing under `tsc -p tsconfig.test.json`, plus a
//     `@ts-expect-error` negative.
//   • `DriverEventSchema`'s type assertion is sound only because set
//     membership (keyed by `type`) and union membership (keyed by `category`)
//     are the same predicate over the registered arms. Nothing else states
//     that, so it is asserted directly.

import { describe, expect, it } from "vitest";

import { DRIVER_EVENT_TYPES, DriverEventSchema, type DriverEventType } from "../driver-event.js";
import {
  SESSION_EVENT_CATEGORY_BY_TYPE,
  SESSION_EVENT_TYPES,
  SessionEventSchema,
  type EventCategory,
} from "../event.js";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const USER_ID = "660e8400-e29b-41d4-a716-446655440001";
const RUN_ID = "990e8400-e29b-41d4-a716-446655440004";
const VERSION = "1.0";

// One driver-category fixture and one non-driver one — the minimum that
// separates "refuses non-driver events" from "refuses everything". Shaped to
// match the wire fixtures in session-event.test.ts; that suite owns the
// round-trip coverage, this one owns only the driver narrowing.
const buildAssistantMessage = () => ({
  id: "evt-3601",
  sessionId: SESSION_ID,
  sequence: 40,
  occurredAt: "2026-01-22T19:15:01.000Z",
  category: "assistant_output" as const,
  type: "assistant.message" as const,
  actor: null,
  version: VERSION,
  payload: {
    sessionId: SESSION_ID,
    runId: RUN_ID,
    contentType: "text/markdown",
    contentLength: 4096,
  },
});

const buildSessionCreated = () => ({
  id: "evt-0001",
  sessionId: SESSION_ID,
  sequence: 0,
  occurredAt: "2026-01-22T19:14:35.000Z",
  category: "session_lifecycle" as const,
  type: "session.created" as const,
  actor: USER_ID,
  version: VERSION,
  payload: {
    sessionId: SESSION_ID,
    config: { resourceLimits: { sessions: 10 } },
    metadata: { source: "cli" },
  },
});

// The seven categories decision #4 ratifies, hand-transcribed. The
// `EventCategory` element type is the first bind: a category string that is
// not a canonical category fails to compile here.
const DRIVER_EVENT_CATEGORIES: readonly EventCategory[] = [
  "run_lifecycle",
  "assistant_output",
  "tool_activity",
  "interactive_request",
  "artifact_publication",
  "usage_telemetry",
  "runtime_node_lifecycle",
];

// One sample from each of five driver categories that register a payload
// variant — `run_lifecycle`, `assistant_output`, `tool_activity`,
// `interactive_request` and `artifact_publication`. The element type is the
// pin: `DriverEventType` is derived by `Extract` over the union's literal
// `category` member, so a category dropped or misspelled in the derivation
// removes its arms from the type and fails this declaration at COMPILE time
// (vitest strips types and would not catch it). The set-versus-type bind below
// covers every registered arm.
const DRIVER_EVENT_TYPE_SAMPLES: readonly DriverEventType[] = [
  "run.safety_buffering_updated",
  "assistant.message",
  "tool.invoked",
  "question.asked",
  "git.settled",
];

describe("DriverEvent — the driver slice of the census", () => {
  it("DRIVER_EVENT_TYPES is exactly the census filtered to the seven driver categories", () => {
    const driverCategories = new Set<EventCategory>(DRIVER_EVENT_CATEGORIES);
    expect(driverCategories.size).toBe(7);

    // The independent path: walk the registry rather than the arrays the
    // export itself spreads, so a category silently dropped FROM the export
    // shows up as a missing member here.
    const expected = [...SESSION_EVENT_CATEGORY_BY_TYPE.entries()]
      .filter(([, category]) => driverCategories.has(category))
      .map(([eventType]) => eventType);
    expect([...DRIVER_EVENT_TYPES].sort()).toEqual([...expected].sort());
  });

  it("set membership and category membership are the same predicate over every registered arm", () => {
    // The soundness bridge under `DriverEventSchema`'s type assertion: the
    // schema's runtime check is keyed by `type` and the static `DriverEvent`
    // it claims to produce is keyed by `category`. They coincide only because
    // the arrays and the union both agree with the registry — assert that,
    // rather than trusting two derivations to stay in step.
    const driverCategories = new Set<EventCategory>(DRIVER_EVENT_CATEGORIES);
    for (const registered of SESSION_EVENT_TYPES) {
      const category = SESSION_EVENT_CATEGORY_BY_TYPE.get(registered);
      expect(category).toBeDefined();
      expect(DRIVER_EVENT_TYPES.has(registered)).toBe(
        category !== undefined && driverCategories.has(category),
      );
    }
  });

  it("every DriverEventType sample is a set member and a parseable union arm", () => {
    // Runtime read of the compile-time fixture, so the pin anchors to an
    // executing assertion rather than sitting inert (the `@ts-expect-error`
    // idiom the provider-driver suite uses).
    for (const sample of DRIVER_EVENT_TYPE_SAMPLES) {
      expect(DRIVER_EVENT_TYPES.has(sample)).toBe(true);
      expect(SESSION_EVENT_TYPES).toContain(sample);
    }
  });

  it("a non-driver census type is not assignable to DriverEventType at compile time", () => {
    // `session.created` is a registered census member, so this is a genuine
    // narrowing proof rather than a spelling check: the category list, not
    // the census, is what excludes it. An UNUSED `@ts-expect-error` is itself
    // a TS2578 error, so if `session_lifecycle` ever joined the driver
    // categories this line would fail the typecheck pass instead of rotting.
    // @ts-expect-error `session.created` is `session_lifecycle`, which is not a driver-event category
    const nonDriverType: DriverEventType = "session.created";
    expect(DRIVER_EVENT_TYPES.has(nonDriverType)).toBe(false);
  });

  it("DriverEventSchema accepts a driver event", () => {
    const parsed = DriverEventSchema.safeParse(buildAssistantMessage());
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual(buildAssistantMessage());
  });

  it("DriverEventSchema REFUSES a schema-valid non-driver session event", () => {
    const nonDriver = buildSessionCreated();
    // Premise first: without this the refusal below could be any parse
    // failure at all, and the test would pass on a malformed fixture.
    expect(SessionEventSchema.safeParse(nonDriver).success).toBe(true);

    const parsed = DriverEventSchema.safeParse(nonDriver);
    expect(parsed.success).toBe(false);
    expect(parsed.success === false && parsed.error.issues).toEqual([
      expect.objectContaining({ path: ["type"] }),
    ]);
  });

  it("narrowing does not mutate SessionEventSchema", () => {
    // `.superRefine()` returns `this` and Zod clones internally, so the shared
    // full-union schema is untouched. If that ever stopped holding, every
    // consumer of `SessionEventSchema` would silently narrow to driver events
    // — including the daemon's own streaming primitive, which validates with
    // it precisely so a non-driver value is DROPPED by the handler's filter
    // rather than killing the subscription.
    const nonDriver = buildSessionCreated();
    expect(SessionEventSchema.safeParse(nonDriver).success).toBe(true);
    expect(DriverEventSchema.safeParse(nonDriver).success).toBe(false);
  });
});
