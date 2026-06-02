// Plan-003 PR #135 — Test C1: `RuntimeNodeAttach` request/response contract.
//
// Backstops Spec-003 line 69 (RuntimeNodeAttach required fields) and Spec-003
// line 53 (`client_version` floor field — the daemon's reported version, which
// the Phase-3 attach service floor-compares against `sessions.min_client_version`
// per ADR-018 §Decision #4 / I-003-1). T1.1 ships only the contract SURFACE;
// these tests pin the wire shape (api-payload-contracts.md:486-499).
//
// Coverage shape:
//   • RuntimeNodeAttachRequestSchema ACCEPTS a payload with all required fields
//     including `clientVersion`
//   • REJECTS payloads missing `clientVersion` (Spec-003 line 53 floor field),
//     missing `nodeId`, with an out-of-enum `healthState`, and with an unknown
//     extra key (the `.strict()` drift guard)
//   • clientVersion is the branded MAJOR.MINOR semver (EventEnvelopeVersion),
//     NOT a plain string — a non-semver string is rejected (catch #1: a raw
//     string would silently break the semver-aware floor comparison)
//   • RuntimeNodeAttachResponseSchema ACCEPTS a response carrying
//     `readOnly: boolean` (+ the other fields), and `readOnly` is ORTHOGONAL to
//     `state` (a node may be `online` AND `readOnly`)
//   • NodeId is a non-UUID opaque brand (catch #2): a plain non-empty string is
//     accepted, empty/oversize rejected — it does NOT require UUID format
//   • NodeState is exactly the 5-value liveness enum aligned with the
//     `runtime_node_attachments.state` CHECK (shared-postgres-schema.md:202-203)
//   • RuntimeNodeHealthState is exactly the 2-value daemon-reported health enum
//     (catch #10 — the hoisted shared wire enum, distinct from NodeState)
import { describe, expect, it } from "vitest";

import {
  NODE_ID_MAX_LEN,
  NodeIdSchema,
  NodeStateSchema,
  RUNTIME_NODE_CAPABILITY_UPDATE_REASON_MAX_LEN,
  RuntimeNodeAttachRequestSchema,
  RuntimeNodeAttachResponseSchema,
  RuntimeNodeCapabilityUpdateRequestSchema,
  RuntimeNodeCapabilityUpdateResponseSchema,
  RuntimeNodeHealthStateSchema,
} from "../runtime-node.js";

// Fixtures must be VALID per the imported upstream schemas:
//   • sessionId / participantId pass through `z.uuid()` (brandedUuidIdSchema)
//   • clientVersion must satisfy EventEnvelopeVersionSchema — a "MAJOR.MINOR"
//     semver string (event.ts:124); "1.0" is the canonical accepted form
//   • nodeId is any non-empty string ≤ NODE_ID_MAX_LEN (daemon-assigned opaque)
const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const PARTICIPANT_ID = "660e8400-e29b-41d4-a716-446655440001";
const NODE_ID = "node-daemon-abc123";
const CLIENT_VERSION = "1.0";

const buildValidAttachRequest = () => ({
  sessionId: SESSION_ID,
  participantId: PARTICIPANT_ID,
  nodeId: NODE_ID,
  clientVersion: CLIENT_VERSION,
  capabilities: { ptyHost: true, maxConcurrentRuns: 4 },
  healthState: "online" as const,
});

const buildValidAttachResponse = () => ({
  attachmentId: "880e8400-e29b-41d4-a716-446655440003",
  state: "online" as const,
  readOnly: false,
  attachedAt: "2026-01-22T19:14:35.000Z",
});

describe("RuntimeNodeAttachRequestSchema (C1: required fields)", () => {
  it("accepts a payload with all required fields including clientVersion", () => {
    expect(RuntimeNodeAttachRequestSchema.safeParse(buildValidAttachRequest()).success).toBe(true);
  });

  it("rejects a payload missing clientVersion (Spec-003 line 53 floor field)", () => {
    const { clientVersion: _omitted, ...withoutClientVersion } = buildValidAttachRequest();
    expect(RuntimeNodeAttachRequestSchema.safeParse(withoutClientVersion).success).toBe(false);
  });

  it("rejects a payload missing nodeId", () => {
    const { nodeId: _omitted, ...withoutNodeId } = buildValidAttachRequest();
    expect(RuntimeNodeAttachRequestSchema.safeParse(withoutNodeId).success).toBe(false);
  });

  it("rejects a payload with an out-of-enum healthState", () => {
    // "offline" is a presence-derived value (Postgres health_state), NOT a
    // daemon-reportable wire health value — the 2-value wire enum excludes it.
    const broken = { ...buildValidAttachRequest(), healthState: "offline" };
    expect(RuntimeNodeAttachRequestSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects a payload with an unknown extra key (.strict drift guard)", () => {
    const broken = { ...buildValidAttachRequest(), bogusField: "nope" };
    expect(RuntimeNodeAttachRequestSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects a clientVersion that is not a MAJOR.MINOR semver (catch #1)", () => {
    // A plain string passes a naive `z.string()` but breaks the semver-aware
    // floor comparison — EventEnvelopeVersionSchema rejects non-semver forms.
    const broken = { ...buildValidAttachRequest(), clientVersion: "latest" };
    expect(RuntimeNodeAttachRequestSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects a clientVersion with a numeric / three-segment / leading-zero shape", () => {
    for (const candidate of ["1", "1.0.0", "01.0", "1.01"]) {
      const broken = { ...buildValidAttachRequest(), clientVersion: candidate };
      expect(RuntimeNodeAttachRequestSchema.safeParse(broken).success).toBe(false);
    }
  });

  it("rejects an invalid (non-UUID) sessionId / participantId", () => {
    expect(
      RuntimeNodeAttachRequestSchema.safeParse({
        ...buildValidAttachRequest(),
        sessionId: "not-a-uuid",
      }).success,
    ).toBe(false);
    expect(
      RuntimeNodeAttachRequestSchema.safeParse({
        ...buildValidAttachRequest(),
        participantId: "not-a-uuid",
      }).success,
    ).toBe(false);
  });
});

describe("RuntimeNodeAttachResponseSchema (C1: readOnly boolean)", () => {
  it("accepts a response carrying readOnly: boolean (+ the other fields)", () => {
    expect(RuntimeNodeAttachResponseSchema.safeParse(buildValidAttachResponse()).success).toBe(
      true,
    );
  });

  it("accepts a response that is online AND readOnly (orthogonal axes)", () => {
    // I-003-1 design surface: a below-floor daemon is ADMITTED (state=online),
    // but read-only (readOnly=true). The two axes are independent.
    const onlineReadOnly = {
      ...buildValidAttachResponse(),
      state: "online" as const,
      readOnly: true,
    };
    expect(RuntimeNodeAttachResponseSchema.safeParse(onlineReadOnly).success).toBe(true);
  });

  it("rejects a non-boolean readOnly", () => {
    const broken = { ...buildValidAttachResponse(), readOnly: "true" };
    expect(RuntimeNodeAttachResponseSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects an out-of-enum state", () => {
    const broken = { ...buildValidAttachResponse(), state: "bogus" };
    expect(RuntimeNodeAttachResponseSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects an unknown extra key (.strict drift guard)", () => {
    const broken = { ...buildValidAttachResponse(), bogusField: "nope" };
    expect(RuntimeNodeAttachResponseSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects a malformed attachedAt (z.iso.datetime is load-bearing)", () => {
    // A bare `z.string()` would accept this; `z.iso.datetime({ offset: true })`
    // rejects a non-ISO value, so this pins the datetime validator.
    const broken = { ...buildValidAttachResponse(), attachedAt: "not-a-date" };
    expect(RuntimeNodeAttachResponseSchema.safeParse(broken).success).toBe(false);
  });

  it("accepts a numeric-offset attachedAt (RFC 3339 { offset: true } widening)", () => {
    // Positive proof the `{ offset: true }` option widens default Z-only
    // acceptance to RFC 3339 §5.6 numeric offsets.
    const numericOffset = {
      ...buildValidAttachResponse(),
      attachedAt: "2026-01-22T19:14:35.000+05:00",
    };
    expect(RuntimeNodeAttachResponseSchema.safeParse(numericOffset).success).toBe(true);
  });

  it("rejects an empty attachmentId (.min(1) non-empty defense)", () => {
    const broken = { ...buildValidAttachResponse(), attachmentId: "" };
    expect(RuntimeNodeAttachResponseSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects a response missing a required field (symmetry with request side)", () => {
    const { attachmentId: _omitted, ...withoutAttachmentId } = buildValidAttachResponse();
    expect(RuntimeNodeAttachResponseSchema.safeParse(withoutAttachmentId).success).toBe(false);
  });
});

describe("NodeIdSchema (catch #2: non-UUID opaque daemon-assigned brand)", () => {
  it("accepts a plain non-empty string (does NOT require UUID format)", () => {
    expect(NodeIdSchema.safeParse("node-daemon-abc123").success).toBe(true);
  });

  it("rejects an empty string", () => {
    expect(NodeIdSchema.safeParse("").success).toBe(false);
  });

  it("rejects an oversized node id (defense-in-depth length cap)", () => {
    expect(NodeIdSchema.safeParse("x".repeat(NODE_ID_MAX_LEN + 1)).success).toBe(false);
  });

  it("accepts a node id at exactly the length cap (boundary)", () => {
    expect(NodeIdSchema.safeParse("x".repeat(NODE_ID_MAX_LEN)).success).toBe(true);
  });
});

describe("NodeStateSchema (5-value liveness enum; shared-postgres-schema.md:202-203)", () => {
  it.each(["registering", "online", "degraded", "offline", "revoked"])(
    "accepts the liveness value %s",
    (value) => {
      expect(NodeStateSchema.safeParse(value).success).toBe(true);
    },
  );

  it("rejects readOnly as a state value (permission axis is NOT a NodeState)", () => {
    expect(NodeStateSchema.safeParse("readOnly").success).toBe(false);
  });
});

describe("RuntimeNodeHealthStateSchema (catch #10: 2-value daemon-reported health enum)", () => {
  it.each(["online", "degraded"])("accepts the health value %s", (value) => {
    expect(RuntimeNodeHealthStateSchema.safeParse(value).success).toBe(true);
  });

  it("rejects offline (presence-derived, not a daemon-reportable wire value)", () => {
    expect(RuntimeNodeHealthStateSchema.safeParse("offline").success).toBe(false);
  });
});

// --------------------------------------------------------------------------
// Plan-003 PR #135 — Test C2: `RuntimeNodeCapabilityUpdate` request/response.
// --------------------------------------------------------------------------
//
// Backstops Spec-003 line 71 (capability additions, removals, AND health
// changes). The `capabilities` map is a FULL REPLACEMENT set — additions and
// removals are both expressed by the new map (removal = key omitted), so the
// add-only and removal cases differ only in the map contents. Health
// transitions ride the optional `healthChanges` object, whose `state` is the
// full 5-value `NodeState` liveness enum (NOT the 2-value wire-health enum).
// Wire shape pinned: api-payload-contracts.md:508-518.
const buildValidCapabilityUpdateRequest = () => ({
  nodeId: NodeIdSchema.parse(NODE_ID),
  capabilities: { "feature.x": { enabled: true } },
});

const buildValidCapabilityUpdateResponse = () => ({
  nodeId: NodeIdSchema.parse(NODE_ID),
  state: "online" as const,
  updatedAt: "2026-06-01T00:00:00Z",
});

describe("RuntimeNodeCapabilityUpdateRequestSchema (C2: additions / removals / health)", () => {
  it("accepts an add-only payload (replacement map carries the new capability)", () => {
    // (a) additions — a non-empty capabilities map, no healthChanges. The
    // builder already returns exactly this shape.
    const addOnly = buildValidCapabilityUpdateRequest();
    expect(RuntimeNodeCapabilityUpdateRequestSchema.safeParse(addOnly).success).toBe(true);
  });

  it("accepts a removal payload (empty replacement map omits prior capabilities)", () => {
    // (b) removals — an empty map IS a valid replacement set (every prior
    // capability removed). The schema does not require a non-empty record.
    const removal = {
      nodeId: NodeIdSchema.parse(NODE_ID),
      capabilities: {},
    };
    expect(RuntimeNodeCapabilityUpdateRequestSchema.safeParse(removal).success).toBe(true);
  });

  it("accepts a health-change payload with state + reason", () => {
    // (c) health change — `healthChanges` carries a NodeState + free-form reason.
    const healthChange = {
      ...buildValidCapabilityUpdateRequest(),
      healthChanges: { state: "degraded" as const, reason: "ptyHost backpressure" },
    };
    expect(RuntimeNodeCapabilityUpdateRequestSchema.safeParse(healthChange).success).toBe(true);
  });

  it("accepts a health-change payload WITHOUT reason (reason is optional)", () => {
    const healthChangeNoReason = {
      ...buildValidCapabilityUpdateRequest(),
      healthChanges: { state: "online" as const },
    };
    expect(RuntimeNodeCapabilityUpdateRequestSchema.safeParse(healthChangeNoReason).success).toBe(
      true,
    );
  });

  it("accepts a healthChanges.state that is a 5-value NodeState but NOT a 2-value health value", () => {
    // PROVES `healthChanges.state` is wired to the 5-value NodeStateSchema and
    // NOT the 2-value RuntimeNodeHealthStateSchema: "offline" is a valid
    // NodeState (shared-postgres-schema.md:202-203) but is EXCLUDED from the
    // 2-value wire-health enum. If the field were mis-wired to the health enum
    // this payload would be rejected. (Spec-003 line 71 — health changes.)
    for (const state of ["registering", "offline", "revoked"] as const) {
      const update = {
        ...buildValidCapabilityUpdateRequest(),
        healthChanges: { state },
      };
      expect(RuntimeNodeCapabilityUpdateRequestSchema.safeParse(update).success).toBe(true);
    }
  });

  it("rejects a top-level unknown key (.strict drift guard)", () => {
    const broken = { ...buildValidCapabilityUpdateRequest(), bogus: 1 };
    expect(RuntimeNodeCapabilityUpdateRequestSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects a nested unknown key inside healthChanges (nested .strict)", () => {
    // PROVES the nested `healthChanges` object is itself `.strict()` — an
    // unknown key INSIDE it is rejected, not just at the top level.
    const broken = {
      ...buildValidCapabilityUpdateRequest(),
      healthChanges: { state: "online", bogus: 1 },
    };
    expect(RuntimeNodeCapabilityUpdateRequestSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects a payload missing nodeId", () => {
    const { nodeId: _omitted, ...withoutNodeId } = buildValidCapabilityUpdateRequest();
    expect(RuntimeNodeCapabilityUpdateRequestSchema.safeParse(withoutNodeId).success).toBe(false);
  });

  it("rejects an out-of-enum healthChanges.state", () => {
    const broken = {
      ...buildValidCapabilityUpdateRequest(),
      healthChanges: { state: "banana" },
    };
    expect(RuntimeNodeCapabilityUpdateRequestSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects a healthChanges object missing state (state is required, reason is not)", () => {
    // The wire shape is `healthChanges?: { state: NodeState; reason?: string }`
    // — `healthChanges` is optional, but ONCE PRESENT its `state` is required
    // (no `?`). A `healthChanges` carrying only `reason` is rejected.
    const broken = {
      ...buildValidCapabilityUpdateRequest(),
      healthChanges: { reason: "missing the required state" },
    };
    expect(RuntimeNodeCapabilityUpdateRequestSchema.safeParse(broken).success).toBe(false);
  });

  // healthChanges.reason composes `wireFreeFormString` (the package's standard
  // wire free-form-string realization — session.ts:118), so it inherits the
  // trust-boundary guards. These mirror the InviteRevoke.reason coverage
  // (invites.test.ts:282-301), the identical-wire-spec precedent.
  it("rejects a NUL-byte in healthChanges.reason (wireFreeFormString guard)", () => {
    const broken = {
      ...buildValidCapabilityUpdateRequest(),
      healthChanges: { state: "degraded" as const, reason: "degraded\u0000injected" },
    };
    expect(RuntimeNodeCapabilityUpdateRequestSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects an oversized healthChanges.reason (defense-in-depth length cap)", () => {
    const broken = {
      ...buildValidCapabilityUpdateRequest(),
      healthChanges: {
        state: "degraded" as const,
        reason: "x".repeat(RUNTIME_NODE_CAPABILITY_UPDATE_REASON_MAX_LEN + 1),
      },
    };
    expect(RuntimeNodeCapabilityUpdateRequestSchema.safeParse(broken).success).toBe(false);
  });

  it("accepts a healthChanges.reason at exactly the length cap (boundary)", () => {
    const ok = {
      ...buildValidCapabilityUpdateRequest(),
      healthChanges: {
        state: "degraded" as const,
        reason: "x".repeat(RUNTIME_NODE_CAPABILITY_UPDATE_REASON_MAX_LEN),
      },
    };
    expect(RuntimeNodeCapabilityUpdateRequestSchema.safeParse(ok).success).toBe(true);
  });

  it("rejects an empty / whitespace-only healthChanges.reason (helper .min(1) + \\S guard)", () => {
    for (const reason of ["", "   "]) {
      const broken = {
        ...buildValidCapabilityUpdateRequest(),
        healthChanges: { state: "degraded" as const, reason },
      };
      expect(RuntimeNodeCapabilityUpdateRequestSchema.safeParse(broken).success).toBe(false);
    }
  });
});

describe("RuntimeNodeCapabilityUpdateResponseSchema (C2: nodeId + state + updatedAt)", () => {
  it("accepts a response with nodeId, state, and updatedAt", () => {
    expect(
      RuntimeNodeCapabilityUpdateResponseSchema.safeParse(buildValidCapabilityUpdateResponse())
        .success,
    ).toBe(true);
  });

  it("rejects a response missing a required field (state)", () => {
    const { state: _omitted, ...withoutState } = buildValidCapabilityUpdateResponse();
    expect(RuntimeNodeCapabilityUpdateResponseSchema.safeParse(withoutState).success).toBe(false);
  });

  it("rejects a response with an unknown extra key (.strict drift guard)", () => {
    const broken = { ...buildValidCapabilityUpdateResponse(), bogus: "nope" };
    expect(RuntimeNodeCapabilityUpdateResponseSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects an out-of-enum state", () => {
    const broken = { ...buildValidCapabilityUpdateResponse(), state: "bogus" };
    expect(RuntimeNodeCapabilityUpdateResponseSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects a malformed updatedAt (z.iso.datetime is load-bearing)", () => {
    const broken = { ...buildValidCapabilityUpdateResponse(), updatedAt: "not-a-date" };
    expect(RuntimeNodeCapabilityUpdateResponseSchema.safeParse(broken).success).toBe(false);
  });
});
