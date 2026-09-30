// `driver.subscribeEvents` streams one run's driver activity. The daemon handler filters on
// `DRIVER_EVENT_TYPES` and the client validates each frame against `DriverEventSchema`; both
// read the derivation in `../driver-event.js`. Three binds:
//   - The set equals the event registry filtered to the seven driver categories, asserted
//     through the registry rather than by re-spreading the arrays the export spreads.
//   - The type side has no runtime footprint, so a typed fixture and a `@ts-expect-error`
//     pin it under `tsc -p tsconfig.test.json`.
//   - Set membership (keyed by `type`) and union membership (keyed by `category`) are the
//     same predicate over the registered arms, which `DriverEventSchema`'s cast rests on.

import { describe, expect, it } from "vitest";

import { DRIVER_EVENT_TYPES, DriverEventSchema, type DriverEventType } from "../driver-event.js";
import { SESSION_EVENT_CATEGORY_BY_TYPE } from "../event.js";
import { SESSION_EVENT_TYPES } from "../event-registry.js";
import { SessionEventSchema } from "../event.js";
import type { EventCategory } from "../event-envelope.js";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const USER_ID = "660e8400-e29b-41d4-a716-446655440001";
const RUN_ID = "990e8400-e29b-41d4-a716-446655440004";
const VERSION = "1.0";

// One driver-category fixture and one non-driver one: the minimum that separates "refuses
// non-driver events" from "refuses everything". Round-trip coverage is in
// session-event.test.ts.
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
    shape: "chat",
    mainAgent: {
      agentId: "44444444-4444-4444-8444-444444444444",
      name: "Implementer",
      binding: {
        driverName: "claude",
        modelId: "claude-sonnet-5",
        providerAccountId: null,
        effort: null,
      },
      ancestry: [],
      createdAt: "2026-01-22T19:14:35.000Z",
    },
  },
});

// The seven driver categories, hand-transcribed; the `EventCategory` element type makes a
// non-canonical category fail to compile.
const DRIVER_EVENT_CATEGORIES: readonly EventCategory[] = [
  "run_lifecycle",
  "assistant_output",
  "tool_activity",
  "interactive_request",
  "artifact_publication",
  "usage_telemetry",
  "runtime_node_lifecycle",
];

// One sample from each driver category that registers a payload variant. `DriverEventType`
// is derived by `Extract` over the union's `category` member, so a dropped or misspelled
// category removes arms from the type and fails this declaration at compile time (vitest
// strips types and would not catch it).
const DRIVER_EVENT_TYPE_SAMPLES: readonly DriverEventType[] = [
  "run.step_limit_reached",
  "assistant.message",
  "tool.invoked",
  "question.asked",
  "git.settled",
];

describe("DriverEvent — the driver slice of the census", () => {
  it("DRIVER_EVENT_TYPES is exactly the census filtered to the seven driver categories", () => {
    const driverCategories = new Set<EventCategory>(DRIVER_EVENT_CATEGORIES);
    expect(driverCategories.size).toBe(7);

    // Walk the registry, not the arrays the export spreads, so a category dropped from the
    // export shows up as a missing member.
    const expected = [...SESSION_EVENT_CATEGORY_BY_TYPE.entries()]
      .filter(([, category]) => driverCategories.has(category))
      .map(([eventType]) => eventType);
    expect([...DRIVER_EVENT_TYPES].sort()).toEqual([...expected].sort());
  });

  it("set membership and category membership are the same predicate over every registered arm", () => {
    // The schema's runtime check is keyed by `type` and the `DriverEvent` type it claims is
    // keyed by `category`; they coincide only if both agree with the registry.
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
    // Reads the compile-time fixture at runtime so the pin anchors to an executing assertion.
    for (const sample of DRIVER_EVENT_TYPE_SAMPLES) {
      expect(DRIVER_EVENT_TYPES.has(sample)).toBe(true);
      expect(SESSION_EVENT_TYPES).toContain(sample);
    }
  });

  it("a non-driver census type is not assignable to DriverEventType at compile time", () => {
    // `session.created` is a registered event, so this proves the category list, not the
    // registry, excludes it. An unused `@ts-expect-error` is a TS2578 error, so a
    // `session_lifecycle` driver category would fail the typecheck.
    // @ts-expect-error `session.created` is `session_lifecycle`, not a driver category
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
    // Premise: without it the refusal below could be any parse failure.
    expect(SessionEventSchema.safeParse(nonDriver).success).toBe(true);

    const parsed = DriverEventSchema.safeParse(nonDriver);
    expect(parsed.success).toBe(false);
    expect(parsed.success === false && parsed.error.issues).toEqual([
      expect.objectContaining({ path: ["type"] }),
    ]);
  });

  it("narrowing does not mutate SessionEventSchema", () => {
    // `.superRefine()` clones the schema. If it mutated the shared full-union schema, the
    // daemon's streaming primitive would narrow to driver events and kill the subscription
    // instead of dropping non-driver values in the handler's filter.
    const nonDriver = buildSessionCreated();
    expect(SessionEventSchema.safeParse(nonDriver).success).toBe(true);
    expect(DriverEventSchema.safeParse(nonDriver).success).toBe(false);
  });
});
