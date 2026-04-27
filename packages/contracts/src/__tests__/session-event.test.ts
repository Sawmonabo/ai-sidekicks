// Plan-001 PR #2 — Test C3: `SessionEvent discriminated union round-trips
// through JSON`.
//
// Backstops Spec-001 AC1 (initial projection from session.created) and AC6
// (snapshot/replay deterministic — events MUST survive JSON serialization
// unchanged so the projector applied at replay time computes the same
// projection as the projector applied at append time).
//
// Coverage shape:
//   • For each V1 variant (session.created, membership.joined, channel.created):
//       - parse a wire-shaped fixture, JSON-serialize it, JSON-parse it,
//         re-parse through the schema — assert deep equality with the input
//   • Discriminator dispatch is correct (parsed.type narrows the payload)
//   • Unknown `type` discriminator value is rejected
//   • Known type with a payload from a sibling variant is rejected (the
//     `.strict()` modifier prevents cross-variant payload smuggling)
//   • Each variant carries the canonical `category` literal per
//     `SESSION_EVENT_CATEGORY_BY_TYPE`, AND a category/type mismatch is
//     rejected at parse time (Spec-006 §Canonical Serialization Rules
//     §523 — `category` participates in the BLAKE3-hashed canonical bytes)
//   • EventEnvelopeVersion accepts canonical "MAJOR.MINOR" forms and rejects
//     numeric / three-segment / leading-zero variants per ADR-018 §Decision #1
import { describe, expect, it } from "vitest";

import {
  EVENT_ENVELOPE_VERSION_PATTERN,
  EventCategorySchema,
  SESSION_EVENT_CATEGORY_BY_TYPE,
  SESSION_EVENT_TYPES,
  SessionEventSchema,
  type SessionEvent,
} from "../event.js";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const PARTICIPANT_ID = "660e8400-e29b-41d4-a716-446655440001";
const MEMBERSHIP_ID = "770e8400-e29b-41d4-a716-446655440002";
const CHANNEL_ID = "880e8400-e29b-41d4-a716-446655440003";
const VERSION = "1.0";

const buildSessionCreated = () => ({
  id: "evt-0001",
  sessionId: SESSION_ID,
  sequence: 0,
  occurredAt: "2026-01-22T19:14:35.000Z",
  category: "session_lifecycle" as const,
  type: "session.created" as const,
  actor: PARTICIPANT_ID,
  version: VERSION,
  payload: {
    sessionId: SESSION_ID,
    config: { resourceLimits: { sessions: 10 } },
    metadata: { source: "cli" },
  },
});

const buildMembershipJoined = () => ({
  id: "evt-0002",
  sessionId: SESSION_ID,
  sequence: 1,
  occurredAt: "2026-01-22T19:14:36.000Z",
  category: "membership_change" as const,
  type: "membership.joined" as const,
  actor: PARTICIPANT_ID,
  correlationId: "req-001",
  version: VERSION,
  payload: {
    membershipId: MEMBERSHIP_ID,
    participantId: PARTICIPANT_ID,
    role: "owner",
    identityHandle: "alice",
  },
});

const buildChannelCreated = () => ({
  id: "evt-0003",
  sessionId: SESSION_ID,
  sequence: 2,
  occurredAt: "2026-01-22T19:14:37.000Z",
  category: "session_lifecycle" as const,
  type: "channel.created" as const,
  actor: null,
  version: VERSION,
  payload: {
    channelId: CHANNEL_ID,
    name: "main",
  },
});

describe("SessionEventSchema (C3: discriminated-union JSON round-trip)", () => {
  it("registers exactly the V1 subset (session.created, membership.joined, channel.created)", () => {
    expect(SESSION_EVENT_TYPES).toEqual([
      "session.created",
      "membership.joined",
      "channel.created",
    ]);
  });

  it.each([
    ["session.created", buildSessionCreated],
    ["membership.joined", buildMembershipJoined],
    ["channel.created", buildChannelCreated],
  ] as const)("round-trips %s through JSON without loss", (label, build) => {
    const original = build();

    // Wire path: parse → JSON encode → JSON decode → parse again. The schema
    // must be JSON-stable: same shape in, same shape out, same parsed value.
    const firstPass = SessionEventSchema.parse(original);
    const onWire = JSON.stringify(firstPass);
    const offWire = JSON.parse(onWire) as unknown;
    const secondPass = SessionEventSchema.parse(offWire);

    expect(secondPass).toStrictEqual(firstPass);
    expect(secondPass.type).toBe(label);
  });

  it("narrows payload by `type` discriminator (compile-time + runtime)", () => {
    const ev: SessionEvent = SessionEventSchema.parse(buildSessionCreated());

    if (ev.type === "session.created") {
      // TypeScript narrows: `ev.payload.config` is typed as
      // `Record<string, unknown>` here — not `unknown` from the union.
      expect(ev.payload.config).toEqual({ resourceLimits: { sessions: 10 } });
    } else {
      throw new Error(`expected session.created branch, got ${ev.type}`);
    }
  });

  it("rejects an unknown `type` discriminator value", () => {
    const broken = { ...buildSessionCreated(), type: "session.exploded" };
    const result = SessionEventSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it("rejects payload smuggling across discriminator branches", () => {
    // session.created envelope but with a membership.joined payload shape.
    // Because each variant uses `.strict()` the wrong-shape payload must
    // be rejected (no silent reinterpretation).
    const sessionCreated = buildSessionCreated();
    const membershipJoined = buildMembershipJoined();
    const broken = { ...sessionCreated, payload: membershipJoined.payload };
    const result = SessionEventSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it("rejects an envelope missing required common field `sequence`", () => {
    const valid = buildSessionCreated();
    const broken = { ...valid } as Record<string, unknown>;
    // Bracket access required by `noPropertyAccessFromIndexSignature` (we
    // intentionally widened to `Record<string, unknown>` so we can `delete`
    // a typed-required field for the negative test).
    delete broken["sequence"];
    const result = SessionEventSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it.each([
    ["1.0", true],
    ["2.5", true],
    ["10.20", true],
    ["0.0", true],
    ["1", false], // not two-segment
    ["1.0.0", false], // three-segment
    ["1.01", false], // leading zero on MINOR
    ["01.0", false], // leading zero on MAJOR
    ["1.x", false], // non-numeric MINOR
    ["", false], // empty
  ])("EventEnvelopeVersion regex accepts %s -> %s", (candidate, shouldPass) => {
    expect(EVENT_ENVELOPE_VERSION_PATTERN.test(candidate)).toBe(shouldPass);
  });

  it.each([
    ["session.created", buildSessionCreated, "session_lifecycle"],
    ["membership.joined", buildMembershipJoined, "membership_change"],
    ["channel.created", buildChannelCreated, "session_lifecycle"],
  ] as const)("emits the canonical category %s -> %s", (label, build, expected) => {
    // Round-trip parse pin: each variant carries its declared canonical
    // category. This is wire-load-bearing because Spec-006 §523 puts
    // `category` inside the canonical bytes that back the BLAKE3 hash chain
    // and Ed25519 signature; the parsed value must equal the per-type
    // category defined in `SESSION_EVENT_CATEGORY_BY_TYPE`.
    const parsed = SessionEventSchema.parse(build());
    expect(parsed.category).toBe(expected);
    expect(SESSION_EVENT_CATEGORY_BY_TYPE[label]).toBe(expected);
  });

  it("rejects a category/type mismatch (membership_change on session.created)", () => {
    // Wire-integrity check: the per-variant `category: z.literal(...)`
    // forbids cross-namespace smuggling. If this ever silently accepted,
    // the integrity protocol would hash the event under the wrong
    // category byte and replay would diverge.
    const broken = { ...buildSessionCreated(), category: "membership_change" as const };
    const result = SessionEventSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it("rejects an envelope missing required field `category`", () => {
    const valid = buildSessionCreated();
    const broken = { ...valid } as Record<string, unknown>;
    delete broken["category"];
    const result = SessionEventSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it("EventCategorySchema accepts every taxonomy member from api-payload-contracts.md", () => {
    // Pinning the enum values prevents accidental drift from the canonical
    // EventCategory definition. If api-payload-contracts.md adds a category
    // (e.g. cross_node_dispatch via Spec-024), the spec edit must land
    // before this list; the test will fail until both sides agree.
    const expected = [
      "run_lifecycle",
      "assistant_output",
      "tool_activity",
      "interactive_request",
      "artifact_publication",
      "membership_change",
      "session_lifecycle",
      "approval_flow",
      "usage_telemetry",
      "runtime_node_lifecycle",
      "recovery_events",
      "participant_lifecycle",
      "audit_integrity",
      "event_maintenance",
      "policy_events",
    ];
    for (const cat of expected) {
      expect(EventCategorySchema.safeParse(cat).success).toBe(true);
    }
    expect(EventCategorySchema.safeParse("not_a_category").success).toBe(false);
  });
});
