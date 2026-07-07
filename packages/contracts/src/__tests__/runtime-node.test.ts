// Plan-003 PR #135 — Test C1: `RuntimeNodeAttach` request/response contract.
//
// Backstops Spec-003 line 82 (RuntimeNodeAttach required fields) and Spec-003
// line 53 (`client_version` floor field — the daemon's reported version, which
// the Phase-3 attach service floor-compares against `sessions.min_client_version`
// per ADR-018 §Decision #4 / I-003-1). T1.1 ships only the contract SURFACE;
// these tests pin the wire shape (api-payload-contracts.md:496-509).
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
  VERSION_FLOOR_EXCEEDED_CODE,
  VersionFloorExceededErrorSchema,
  type VersionBoundExceededDetails,
  type VersionFloorExceededError,
} from "../error.js";
import { EventCategorySchema } from "../event.js";
import {
  NODE_ID_MAX_LEN,
  NodeIdSchema,
  NodeStateSchema,
  RUNTIME_NODE_CAPABILITY_KEY_MAX_LEN,
  RUNTIME_NODE_CAPABILITY_UPDATE_REASON_MAX_LEN,
  RUNTIME_NODE_DETACH_REASON_MAX_LEN,
  RUNTIME_NODE_EVENT_NAMES,
  RUNTIME_NODE_PLATFORM_MAX_LEN,
  RUNTIME_NODE_VERSION_MAX_LEN,
  RuntimeNodeAttachRequestSchema,
  RuntimeNodeAttachResponseSchema,
  RuntimeNodeCapabilityDeclaredPayloadSchema,
  RuntimeNodeCapabilityUpdatedPayloadSchema,
  RuntimeNodeCapabilityUpdateRequestSchema,
  RuntimeNodeCapabilityUpdateResponseSchema,
  RuntimeNodeDetachRequestSchema,
  RuntimeNodeDetachResponseSchema,
  RuntimeNodeHealthStateSchema,
  RuntimeNodeHeartbeatRequestSchema,
  RuntimeNodeHeartbeatResponseSchema,
  RuntimeNodeOfflinePayloadSchema,
  RuntimeNodeOnlinePayloadSchema,
  RuntimeNodeRegisteredPayloadSchema,
  RuntimeNodeRosterEntrySchema,
  RuntimeNodeRosterRequestSchema,
  RuntimeNodeRosterResponseSchema,
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
// Backstops Spec-003 line 84 (capability additions, removals, AND health
// changes) and Spec-003 line 65 (2026-06-04 `capabilityupdate` amendment — the
// daemon self-report axis is `online ↔ degraded`). The `capabilities` map is a
// FULL REPLACEMENT set — additions and removals are both expressed by the new
// map (removal = key omitted), so the add-only and removal cases differ only in
// the map contents. Health transitions ride the optional `healthChanges`
// object, whose `state` is the 2-value `RuntimeNodeHealthState` wire-health enum
// (online|degraded) — the SAME self-report axis as `attach`/`heartbeat`, NOT the
// broad 5-value `NodeState` (narrowed by T3.0; `offline`/`revoked` are owned by
// other authorities and are unrepresentable here, I-003-2 least-privilege).
// Wire shape pinned: api-payload-contracts.md:518-528.
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
    // (c) health change — `healthChanges` carries a 2-value RuntimeNodeHealthState
    // (online|degraded) + free-form reason.
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

  it("rejects a healthChanges.state that is a 5-value NodeState but NOT a 2-value health value", () => {
    // PROVES `healthChanges.state` is wired to the 2-value
    // RuntimeNodeHealthStateSchema and NOT the 5-value NodeStateSchema (T3.0
    // narrowing): `registering`/`offline`/`revoked` are valid NodeState liveness
    // positions (shared-postgres-schema.md:202-203) but are EXCLUDED from the
    // 2-value daemon-reported wire-health enum, so a daemon self-report carrying
    // one is now UNCONSTRUCTABLE at the schema boundary rather than runtime-
    // accepted. Each rejected arm maps to an authority a daemon self-report is
    // not:
    //   • `registering` — the `registering → online` transition is driven by a
    //     successful daemon-side capability DECLARATION, NOT by `capabilityupdate`
    //     (Spec-003 line 57; the amendment at line 65 forbids `capabilityupdate`
    //     driving `registering → online`). This narrowing is the contract-surface
    //     enforcement; the runtime transition-gating is Plan-003 T3.9.
    //   • `offline` — server-derived liveness-death (the staleness sweep,
    //     Plan-003 T3.6), never daemon-self-reported.
    //   • `revoked` — an authority-issued trust decision (detach/admin, Plan-003
    //     T3.7), never self-asserted.
    // This is the proof of I-003-2's least-privilege corollary (a daemon self-
    // report cannot assert liveness-death or revocation). Spec-003 line 57
    // (online requires a daemon-side capability declaration) + line 65 (2026-06-04
    // `capabilityupdate` amendment — the self-report axis is `online ↔ degraded`).
    for (const state of ["registering", "offline", "revoked"] as const) {
      const update = {
        ...buildValidCapabilityUpdateRequest(),
        healthChanges: { state },
      };
      expect(RuntimeNodeCapabilityUpdateRequestSchema.safeParse(update).success).toBe(false);
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
    // The wire shape is `healthChanges?: { state: "online" | "degraded";
    // reason?: string }` — `healthChanges` is optional, but ONCE PRESENT its
    // `state` is required (no `?`). A `healthChanges` carrying only `reason` is
    // rejected.
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

// --------------------------------------------------------------------------
// Plan-003 PR #135 — Test C6: `RuntimeNodeHeartbeat` request + null response.
// --------------------------------------------------------------------------
//
// Backstops the heartbeat wire shape (api-payload-contracts.md:511-516,569):
// a `nodeId` + a 2-value `healthState`, and a `null` response payload (NOT a
// 204 empty body — the resolver returns `null`, serialized as a 200 success
// envelope). The discriminating test is the 2-value health-enum boundary: a
// mis-wire to the 5-value `NodeStateSchema` would accept `offline`/`registering`/
// `revoked`, so the loop-reject below catches that specific mis-wire. It now
// PARALLELS the capability-update 2-value reject (both `healthChanges.state` and
// `healthState` carry the same `RuntimeNodeHealthState` axis after T3.0), rather
// than inverting it — all three daemon-self-report surfaces reject the broad
// liveness values by construction.
const buildValidHeartbeatRequest = () => ({
  nodeId: NodeIdSchema.parse(NODE_ID),
  healthState: "online" as const,
});

describe("RuntimeNodeHeartbeatRequestSchema (C6: nodeId + 2-value healthState)", () => {
  it("accepts a heartbeat with healthState online", () => {
    expect(RuntimeNodeHeartbeatRequestSchema.safeParse(buildValidHeartbeatRequest()).success).toBe(
      true,
    );
  });

  it("accepts a heartbeat with healthState degraded", () => {
    const degraded = { ...buildValidHeartbeatRequest(), healthState: "degraded" as const };
    expect(RuntimeNodeHeartbeatRequestSchema.safeParse(degraded).success).toBe(true);
  });

  it("rejects a heartbeat missing nodeId", () => {
    const { nodeId: _omitted, ...withoutNodeId } = buildValidHeartbeatRequest();
    expect(RuntimeNodeHeartbeatRequestSchema.safeParse(withoutNodeId).success).toBe(false);
  });

  it("rejects a heartbeat missing healthState (required, not optional)", () => {
    const { healthState: _omitted, ...withoutHealthState } = buildValidHeartbeatRequest();
    expect(RuntimeNodeHeartbeatRequestSchema.safeParse(withoutHealthState).success).toBe(false);
  });

  it("rejects an unknown extra key (.strict drift guard)", () => {
    const broken = { ...buildValidHeartbeatRequest(), bogusField: "nope" };
    expect(RuntimeNodeHeartbeatRequestSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects NodeState liveness values that are NOT 2-value health values (mis-wire guard)", () => {
    // `offline`/`registering`/`revoked` are valid 5-value NodeState liveness
    // positions (shared-postgres-schema.md:202-203) but are EXCLUDED from the
    // 2-value daemon-reported wire-health enum. If `healthState` were mis-wired
    // to the 5-value `NodeStateSchema` these would be ACCEPTED — this loop
    // catches that mis-wire and PARALLELS the capability-update 2-value reject
    // (its `healthChanges.state` carries the same narrow axis after T3.0).
    for (const liveness of ["offline", "registering", "revoked"]) {
      const broken = { ...buildValidHeartbeatRequest(), healthState: liveness };
      expect(RuntimeNodeHeartbeatRequestSchema.safeParse(broken).success).toBe(false);
    }
  });

  it("rejects an empty nodeId (brand .min(1) guard)", () => {
    const broken = { ...buildValidHeartbeatRequest(), nodeId: "" };
    expect(RuntimeNodeHeartbeatRequestSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects an oversized nodeId (brand defense-in-depth length cap)", () => {
    const broken = { ...buildValidHeartbeatRequest(), nodeId: "x".repeat(NODE_ID_MAX_LEN + 1) };
    expect(RuntimeNodeHeartbeatRequestSchema.safeParse(broken).success).toBe(false);
  });
});

describe("RuntimeNodeHeartbeatResponseSchema (C6: null no-content payload)", () => {
  it("accepts null (the wire response is literally null, not a 204 empty body)", () => {
    expect(RuntimeNodeHeartbeatResponseSchema.safeParse(null).success).toBe(true);
  });

  it("rejects a non-null payload (empty object / string / number / undefined)", () => {
    expect(RuntimeNodeHeartbeatResponseSchema.safeParse({}).success).toBe(false);
    expect(RuntimeNodeHeartbeatResponseSchema.safeParse("x").success).toBe(false);
    expect(RuntimeNodeHeartbeatResponseSchema.safeParse(0).success).toBe(false);
    expect(RuntimeNodeHeartbeatResponseSchema.safeParse(undefined).success).toBe(false);
  });
});

// --------------------------------------------------------------------------
// Plan-003 PR #135 — Test C3: `RuntimeNodeDetach` request + null response.
// --------------------------------------------------------------------------
//
// Backstops the detach wire shape (api-payload-contracts.md:530-535,567): a
// `nodeId` + an OPTIONAL free-form `reason`, and a `null` response payload. The
// `reason` field composes `wireFreeFormString` (session.ts:118), so it inherits
// the trust-boundary guards — these mirror the four `InviteRevoke.reason` /
// `RuntimeNodeCapabilityUpdate.healthChanges.reason` guard cases (the identical-
// wire-spec precedents) and pin that `reason` is NOT a bare `z.string()`.
const buildValidDetachRequest = () => ({
  nodeId: NodeIdSchema.parse(NODE_ID),
});

describe("RuntimeNodeDetachRequestSchema (C3: nodeId + optional reason)", () => {
  it("accepts a detach with reason omitted (reason is optional)", () => {
    expect(RuntimeNodeDetachRequestSchema.safeParse(buildValidDetachRequest()).success).toBe(true);
  });

  it("accepts a detach with reason present", () => {
    const withReason = { ...buildValidDetachRequest(), reason: "node shutting down for upgrade" };
    expect(RuntimeNodeDetachRequestSchema.safeParse(withReason).success).toBe(true);
  });

  it("rejects a detach missing nodeId", () => {
    const broken = { reason: "no node id" };
    expect(RuntimeNodeDetachRequestSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects an unknown extra key (.strict drift guard)", () => {
    const broken = { ...buildValidDetachRequest(), bogusField: "nope" };
    expect(RuntimeNodeDetachRequestSchema.safeParse(broken).success).toBe(false);
  });

  // `reason` composes `wireFreeFormString` (session.ts:118) — the four guards
  // below prove it is NOT a bare `z.string()` (the regressed shape T1.2 was
  // round-tripped to fix), mirroring invites.test.ts:282-301.
  it("rejects a NUL-byte in reason (wireFreeFormString guard)", () => {
    const broken = { ...buildValidDetachRequest(), reason: "detach\u0000injected" };
    expect(RuntimeNodeDetachRequestSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects an oversized reason (defense-in-depth length cap)", () => {
    const broken = {
      ...buildValidDetachRequest(),
      reason: "a".repeat(RUNTIME_NODE_DETACH_REASON_MAX_LEN + 1),
    };
    expect(RuntimeNodeDetachRequestSchema.safeParse(broken).success).toBe(false);
  });

  it("accepts a reason at exactly the length cap (boundary)", () => {
    const ok = {
      ...buildValidDetachRequest(),
      reason: "a".repeat(RUNTIME_NODE_DETACH_REASON_MAX_LEN),
    };
    expect(RuntimeNodeDetachRequestSchema.safeParse(ok).success).toBe(true);
  });

  it("rejects an empty / whitespace-only reason (helper .min(1) + \\S guard)", () => {
    for (const reason of ["", "   "]) {
      const broken = { ...buildValidDetachRequest(), reason };
      expect(RuntimeNodeDetachRequestSchema.safeParse(broken).success).toBe(false);
    }
  });
});

describe("RuntimeNodeDetachResponseSchema (C3: null no-content payload)", () => {
  it("accepts null (the wire response is literally null, not a 204 empty body)", () => {
    expect(RuntimeNodeDetachResponseSchema.safeParse(null).success).toBe(true);
  });

  it("rejects a non-null payload (empty object / string / number / undefined)", () => {
    expect(RuntimeNodeDetachResponseSchema.safeParse({}).success).toBe(false);
    expect(RuntimeNodeDetachResponseSchema.safeParse("x").success).toBe(false);
    expect(RuntimeNodeDetachResponseSchema.safeParse(0).success).toBe(false);
    expect(RuntimeNodeDetachResponseSchema.safeParse(undefined).success).toBe(false);
  });
});

// --------------------------------------------------------------------------
// Plan-003 PR #135 — Test C4: `runtime_node.*` event-name taxonomy constants.
// --------------------------------------------------------------------------
//
// C4 acceptance criterion: the exported 7-name `runtime_node.*` set is exactly
// equal (as a sorted set) to the 7 names in the Runtime Node Lifecycle taxonomy
// table at Spec-006 lines 407-413 — neither superset nor subset. The SET
// MEMBERSHIP is the contract (additions MINOR, removals MAJOR under ADR-018
// §Decision #8), not the declaration order, so the equality is asserted
// order-independently against a hardcoded expected-7 array re-derived from the
// spec table (NOT transcribed from a Plan-003 gloss).
//
// The `expectedSevenFromSpec006` array is the test's independent source of truth,
// each entry mapped to its Spec-006 table row:
//   • runtime_node.registered          — Spec-006:407
//   • runtime_node.online              — Spec-006:408
//   • runtime_node.degraded            — Spec-006:409
//   • runtime_node.offline             — Spec-006:410
//   • runtime_node.revoked             — Spec-006:411
//   • runtime_node.capability_declared — Spec-006:412
//   • runtime_node.capability_updated  — Spec-006:413
// The 2 `session.clock_*` rows (Spec-006:414-415) are DELIBERATELY ABSENT: they
// share the `runtime_node_lifecycle` category but retain the `session.` prefix by
// name-preservation (Spec-006:417 / ADR-018 §Decision #8) and were promoted
// from Spec-015 §Reserved Events.
const expectedSevenFromSpec006 = [
  "runtime_node.registered",
  "runtime_node.online",
  "runtime_node.degraded",
  "runtime_node.offline",
  "runtime_node.revoked",
  "runtime_node.capability_declared",
  "runtime_node.capability_updated",
];

describe("RUNTIME_NODE_EVENT_NAMES (C4: 7-name runtime_node.* taxonomy)", () => {
  it("is exactly the sorted set of the 7 names in Spec-006 lines 407-413", () => {
    // Order-independent SET equality: sort both sides so a reorder of either the
    // export tuple or the spec table does not spuriously fail, while a
    // missing/extra/renamed name does (the membership IS the contract per
    // Spec-006:407-413). A spread is required because the export is `readonly` and
    // `.sort()` mutates in place.
    expect([...RUNTIME_NODE_EVENT_NAMES].sort()).toEqual([...expectedSevenFromSpec006].sort());
  });

  it("has exactly 7 entries (neither superset nor subset of the spec set)", () => {
    expect(RUNTIME_NODE_EVENT_NAMES).toHaveLength(7);
  });

  it("contains no duplicates (set cardinality equals tuple length)", () => {
    expect(new Set(RUNTIME_NODE_EVENT_NAMES).size).toBe(7);
  });

  it("every entry carries the runtime_node. prefix (catches a session.clock_* leak)", () => {
    // The prefix guard is the discriminating assertion: if a `session.clock_*`
    // name (Spec-006:414-415) leaked into the set it would fail here even if the
    // count stayed at 7, because those names retain the `session.` prefix.
    for (const eventName of RUNTIME_NODE_EVENT_NAMES) {
      expect(eventName.startsWith("runtime_node.")).toBe(true);
    }
  });

  it("excludes the session.clock_* pair (name-preservation boundary, Spec-006:414-417)", () => {
    // Explicit negative: the two same-category clock events are NOT in the set.
    expect(RUNTIME_NODE_EVENT_NAMES).not.toContain("session.clock_unsynced");
    expect(RUNTIME_NODE_EVENT_NAMES).not.toContain("session.clock_corrected");
  });

  it("targets the runtime_node_lifecycle category, which is registered in Plan-001's EventCategorySchema", () => {
    // Cross-ref proving the CP-003-1 split is real: Plan-003 ships these NAME
    // constants, but the category they belong to is owned by Plan-001 and already
    // present in `EventCategorySchema` (event.ts:101). This confirms the target
    // category exists in Plan-001's enum; the name→category binding itself is
    // Plan-006's to register (CP-003-1), not asserted here.
    expect(EventCategorySchema.safeParse("runtime_node_lifecycle").success).toBe(true);
  });
});

// --------------------------------------------------------------------------
// Plan-003 PR #135 — Test C5: typed `VERSION_FLOOR_EXCEEDED` consumer anchor.
// --------------------------------------------------------------------------
//
// This block is a Plan-003 CONSUMER-SIDE conformance anchor, NOT a re-test of
// Plan-001's error-schema matrix. I-003-1 ("Attach is admit-not-eject for
// below-floor daemons") requires that a below-floor write returns a *typed*
// `VERSION_FLOOR_EXCEEDED` (Spec-003:53, Spec-003 AC4:130; ADR-018 §Decision
// #4 / §Decision #10). The concrete realization of that typed error is the
// Plan-001-owned `VersionFloorExceededError` / `VersionFloorExceededErrorSchema`
// / `VERSION_FLOOR_EXCEEDED_CODE` in `error.ts`. The two assertions here pin
// Plan-003's consuming dependency on that contract — the exact-T1.7 precedent
// (T1.7 pinned Plan-003's dependency on the Plan-001 Postgres `min_client_version`
// column; this pins its dependency on the Plan-001 typed error).
//
// DELIBERATELY NOT RE-RUN HERE: `error.test.ts`'s
// `describe("VersionFloorExceededErrorSchema")` (Plan-001 T2.3) owns the full
// accept/reject/strict-key/oversize/whitespace/boundary/missing-field matrix.
// This block adds exactly what that matrix does NOT cover — see each `it`.
//
// PHASE-3 TRIPWIRE: only the typed-CONTRACT conformance proven here ships in
// Plan-003 Phase 1. The RUNTIME admit-not-eject behavior — the attach service
// actually returning this error on a below-floor write and then admitting the
// daemon read-only (Spec-003 AC4:130) — lands at Plan-003 Phase 3 (P3/P4).
//
// Cites: Spec-003:53, Spec-003 AC4:130, I-003-1, ADR-018 §Decision #4 /
// §Decision #10, docs/architecture/contracts/error-contracts.md:377.
describe("VersionFloorExceededErrorSchema (C5: VERSION_FLOOR_EXCEEDED typed-contract conformance — Plan-003 consumer anchor)", () => {
  it("pins the wire code literal to the value registered in error-contracts.md:377", () => {
    // The expected string is single-sourced from the INDEPENDENT registry —
    // error-contracts.md:377 maps the typed `VERSION_FLOOR_EXCEEDED` name to the
    // dotted wire code `version.floor_exceeded` (ADR-018 §Decision #10 mandates
    // registration there). That doc, NOT `error.ts`, is the source of the
    // expected value here, so this pin detects drift in `error.ts` rather than
    // tautologically agreeing with it.
    //
    // Non-duplicative vs. error.test.ts: every test there references the constant
    // SYMBOLICALLY (`code: VERSION_FLOOR_EXCEEDED_CODE`), so renaming the
    // constant's VALUE (e.g. to `"version.floor_breached"`) would leave all of
    // `error.test.ts` green while silently breaking the cross-process / cross-SDK
    // wire contract that I-003-1 depends on. This is the only test in the repo
    // that pins the literal string itself.
    expect(VERSION_FLOOR_EXCEEDED_CODE).toBe("version.floor_exceeded");
  });

  it("binds Plan-003's below-floor rejection payload to its TYPE and preserves the upgradePath through a parse", () => {
    // Discriminator vs. error.test.ts's un-annotated `buildValidFloorError()`
    // literal (error.test.ts:377-385,398): that fixture proves the schema ACCEPTS
    // the shape at runtime; the explicit type annotations below prove Plan-003's
    // CONSUMING code sees a TYPE that agrees with the schema (compile-time-checked
    // by the package's `isolatedDeclarations` + `exactOptionalPropertyTypes`
    // build). `upgradePath` is `string | undefined` on the interface, so including
    // it with a concrete value is correct under `exactOptionalPropertyTypes`.
    const belowFloorDetails: VersionBoundExceededDetails = {
      attemptedVersion: "0.9",
      acceptedRange: { min: "1.0", max: "2.0" },
      upgradePath: "Upgrade the client to 1.0 or higher: https://example.com/upgrade",
    };
    const belowFloorRejection: VersionFloorExceededError = {
      code: VERSION_FLOOR_EXCEEDED_CODE,
      message: "Client protocol version 0.9 is below daemon's accepted floor 1.0.",
      details: belowFloorDetails,
    };

    const result = VersionFloorExceededErrorSchema.safeParse(belowFloorRejection);
    expect(result.success).toBe(true);

    // ADR-018 §Decision #10: the typed floor error carries a human-readable
    // upgrade path so the read-only-admitted daemon can surface remediation
    // (graceful degradation, not ejection — I-003-1 / Spec-003:53). Assert the
    // schema PRESERVES it through a parse rather than dropping the optional field.
    if (result.success) {
      expect(result.data.details.upgradePath).toBe(belowFloorRejection.details.upgradePath);
    }
  });
});

// --------------------------------------------------------------------------
// Plan-003 Phase 2 (PR #137) — Test C7: per-event `runtime_node.*` payload schemas.
// --------------------------------------------------------------------------
//
// Backstops the 5 daemon-reachable per-event PAYLOAD shapes authored in Plan-003
// Phase 2 (CP-003-1; Spec-006:407-413): `registered`, `online`, `offline`,
// `capability_declared`, `capability_updated`. These validate the
// `EventEnvelope.payload` CONTENTS only — the integrity envelope + discriminated-
// union registration are Plan-006 Tier 4. The discriminating coverage:
//   • each schema `.parse()`-es a fully-valid payload and round-trips
//   • a missing required field, an unknown extra key (`.strict()`), and a
//     wrong-type field each reject
//   • `offline.reason` accepts each of the 3 enum values and rejects a 4th
//   • REDUCED-base proof: `capability_declared` REJECTS `newState`/`previousState`
//     keys (the reduced capability base omits the NodeState-transition fields,
//     proving capability events are not lifecycle transitions), while a lifecycle
//     schema ACCEPTS `previousState` omitted + `newState` present
//   • `actor` accepts a string, accepts `null`, accepts omitted
//     (`.nullable().optional()`), and rejects a non-string
const VALID_LIFECYCLE_BASE = {
  sessionId: SESSION_ID,
  nodeId: NODE_ID,
  previousState: "registering" as const,
  newState: "online" as const,
  actor: PARTICIPANT_ID,
};

const buildValidRegisteredPayload = () => ({
  ...VALID_LIFECYCLE_BASE,
  capabilities: { ptyHost: true, maxConcurrentRuns: 4 },
  nodeVersion: "1.4.2",
  platform: "darwin-arm64",
});

const buildValidOnlinePayload = () => ({ ...VALID_LIFECYCLE_BASE });

const buildValidOfflinePayload = () => ({
  ...VALID_LIFECYCLE_BASE,
  newState: "offline" as const,
  lastHeartbeatAt: "2026-06-01T00:00:00.000Z",
  reason: "explicit_shutdown" as const,
});

const buildValidCapabilityDeclaredPayload = () => ({
  sessionId: SESSION_ID,
  nodeId: NODE_ID,
  actor: PARTICIPANT_ID,
  capability: "provider-driver",
  capabilityDetails: { contractVersion: "1.0", flags: { streaming: true } },
});

const buildValidCapabilityUpdatedPayload = () => ({
  sessionId: SESSION_ID,
  nodeId: NODE_ID,
  actor: PARTICIPANT_ID,
  capability: "provider-driver",
  previousState: { contractVersion: "1.0" },
  newState: { contractVersion: "1.1" },
});

describe("RuntimeNodeRegisteredPayloadSchema (C7: registered = base + {capabilities, nodeVersion, platform})", () => {
  it("parses a fully-valid payload and round-trips", () => {
    const payload = buildValidRegisteredPayload();
    const result = RuntimeNodeRegisteredPayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.nodeVersion).toBe("1.4.2");
      expect(result.data.platform).toBe("darwin-arm64");
      expect(result.data.capabilities).toEqual(payload.capabilities);
    }
  });

  it("rejects a payload missing the required nodeId", () => {
    const { nodeId: _omitted, ...withoutNodeId } = buildValidRegisteredPayload();
    expect(RuntimeNodeRegisteredPayloadSchema.safeParse(withoutNodeId).success).toBe(false);
  });

  it("rejects a payload missing the required newState (lifecycle transition target)", () => {
    const { newState: _omitted, ...withoutNewState } = buildValidRegisteredPayload();
    expect(RuntimeNodeRegisteredPayloadSchema.safeParse(withoutNewState).success).toBe(false);
  });

  it("rejects an unknown extra key (.strict drift guard)", () => {
    const broken = { ...buildValidRegisteredPayload(), bogusField: "nope" };
    expect(RuntimeNodeRegisteredPayloadSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects a wrong-type field (capabilities must be a record, not a string)", () => {
    const broken = { ...buildValidRegisteredPayload(), capabilities: "not-a-record" };
    expect(RuntimeNodeRegisteredPayloadSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects an out-of-enum newState", () => {
    const broken = { ...buildValidRegisteredPayload(), newState: "bogus" };
    expect(RuntimeNodeRegisteredPayloadSchema.safeParse(broken).success).toBe(false);
  });

  it("accepts a full-semver nodeVersion that EventEnvelopeVersion would reject", () => {
    // `nodeVersion` is a bounded free string, NOT the MAJOR.MINOR-only
    // `EventEnvelopeVersion` — a three-segment release version must be accepted.
    const ok = { ...buildValidRegisteredPayload(), nodeVersion: "10.20.30" };
    expect(RuntimeNodeRegisteredPayloadSchema.safeParse(ok).success).toBe(true);
  });

  it("rejects an oversized nodeVersion / platform (defense-in-depth length caps)", () => {
    expect(
      RuntimeNodeRegisteredPayloadSchema.safeParse({
        ...buildValidRegisteredPayload(),
        nodeVersion: "1".repeat(RUNTIME_NODE_VERSION_MAX_LEN + 1),
      }).success,
    ).toBe(false);
    expect(
      RuntimeNodeRegisteredPayloadSchema.safeParse({
        ...buildValidRegisteredPayload(),
        platform: "x".repeat(RUNTIME_NODE_PLATFORM_MAX_LEN + 1),
      }).success,
    ).toBe(false);
  });
});

describe("RuntimeNodeOnlinePayloadSchema (C7: online = base, no extension)", () => {
  it("parses a fully-valid base payload and round-trips", () => {
    expect(RuntimeNodeOnlinePayloadSchema.safeParse(buildValidOnlinePayload()).success).toBe(true);
  });

  it("ACCEPTS previousState omitted with newState present (lifecycle base optionality)", () => {
    // The full lifecycle base types `previousState?` optional, `newState` required
    // — a first-ever transition (no prior state) is valid.
    const { previousState: _omitted, ...withoutPrevious } = buildValidOnlinePayload();
    expect(RuntimeNodeOnlinePayloadSchema.safeParse(withoutPrevious).success).toBe(true);
  });

  it("ACCEPTS sessionId omitted (lifecycle base types sessionId optional)", () => {
    // The full lifecycle base types `sessionId?` optional (Spec-006's `sessionId?`
    // base) — symmetric coverage with `previousState`/`actor` omitted above. A
    // future accidental drop of `.optional()` on `sessionId` would be an uncaught
    // false-reject regression.
    const { sessionId: _omitted, ...withoutSessionId } = buildValidOnlinePayload();
    expect(RuntimeNodeOnlinePayloadSchema.safeParse(withoutSessionId).success).toBe(true);
  });

  it("rejects a payload missing the required newState", () => {
    const { newState: _omitted, ...withoutNewState } = buildValidOnlinePayload();
    expect(RuntimeNodeOnlinePayloadSchema.safeParse(withoutNewState).success).toBe(false);
  });

  it("rejects an unknown extra key (.strict drift guard)", () => {
    const broken = { ...buildValidOnlinePayload(), capabilities: {} };
    expect(RuntimeNodeOnlinePayloadSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects a wrong-type newState (must be an enum string, not a number)", () => {
    const broken = { ...buildValidOnlinePayload(), newState: 7 };
    expect(RuntimeNodeOnlinePayloadSchema.safeParse(broken).success).toBe(false);
  });

  it("accepts actor as a string, as null, and omitted; rejects a non-string actor", () => {
    expect(RuntimeNodeOnlinePayloadSchema.safeParse(buildValidOnlinePayload()).success).toBe(true);
    expect(
      RuntimeNodeOnlinePayloadSchema.safeParse({ ...buildValidOnlinePayload(), actor: null })
        .success,
    ).toBe(true);
    const { actor: _omitted, ...withoutActor } = buildValidOnlinePayload();
    expect(RuntimeNodeOnlinePayloadSchema.safeParse(withoutActor).success).toBe(true);
    expect(
      RuntimeNodeOnlinePayloadSchema.safeParse({ ...buildValidOnlinePayload(), actor: 123 })
        .success,
    ).toBe(false);
  });
});

describe("RuntimeNodeOfflinePayloadSchema (C7: offline = base + {lastHeartbeatAt, reason})", () => {
  it("parses a fully-valid payload and round-trips", () => {
    expect(RuntimeNodeOfflinePayloadSchema.safeParse(buildValidOfflinePayload()).success).toBe(
      true,
    );
  });

  it.each(["heartbeat_lost", "explicit_shutdown", "network_partition"])(
    "accepts the full-contract reason value %s (authored even though Phase 2 emits only explicit_shutdown)",
    (reason) => {
      const ok = { ...buildValidOfflinePayload(), reason };
      expect(RuntimeNodeOfflinePayloadSchema.safeParse(ok).success).toBe(true);
    },
  );

  it("rejects a 4th reason value outside the 3-value enum", () => {
    const broken = { ...buildValidOfflinePayload(), reason: "graceful_drain" };
    expect(RuntimeNodeOfflinePayloadSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects a payload missing the required reason", () => {
    const { reason: _omitted, ...withoutReason } = buildValidOfflinePayload();
    expect(RuntimeNodeOfflinePayloadSchema.safeParse(withoutReason).success).toBe(false);
  });

  it("rejects a payload missing the required nodeId", () => {
    const { nodeId: _omitted, ...withoutNodeId } = buildValidOfflinePayload();
    expect(RuntimeNodeOfflinePayloadSchema.safeParse(withoutNodeId).success).toBe(false);
  });

  it("rejects a malformed lastHeartbeatAt (z.iso.datetime is load-bearing)", () => {
    const broken = { ...buildValidOfflinePayload(), lastHeartbeatAt: "not-a-date" };
    expect(RuntimeNodeOfflinePayloadSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects an unknown extra key (.strict drift guard)", () => {
    const broken = { ...buildValidOfflinePayload(), bogusField: "nope" };
    expect(RuntimeNodeOfflinePayloadSchema.safeParse(broken).success).toBe(false);
  });
});

describe("RuntimeNodeCapabilityDeclaredPayloadSchema (C7: reduced base + {capability, capabilityDetails})", () => {
  it("parses a fully-valid payload and round-trips", () => {
    const payload = buildValidCapabilityDeclaredPayload();
    const result = RuntimeNodeCapabilityDeclaredPayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.capability).toBe("provider-driver");
      expect(result.data.capabilityDetails).toEqual(payload.capabilityDetails);
    }
  });

  it("REJECTS a newState key (reduced base omits the NodeState-transition fields)", () => {
    // Discriminating reduced-base proof: capability events are NOT NodeState
    // transitions (the canonical payload, api-payload-contracts.md:1000, carries no
    // base NodeState fields). A `newState` key is therefore an unknown key under
    // `.strict()` — its presence rejects.
    const broken = { ...buildValidCapabilityDeclaredPayload(), newState: "online" };
    expect(RuntimeNodeCapabilityDeclaredPayloadSchema.safeParse(broken).success).toBe(false);
  });

  it("REJECTS a previousState key (reduced base omits the NodeState-transition fields)", () => {
    const broken = { ...buildValidCapabilityDeclaredPayload(), previousState: "registering" };
    expect(RuntimeNodeCapabilityDeclaredPayloadSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects a payload missing the required capability", () => {
    const { capability: _omitted, ...withoutCapability } = buildValidCapabilityDeclaredPayload();
    expect(RuntimeNodeCapabilityDeclaredPayloadSchema.safeParse(withoutCapability).success).toBe(
      false,
    );
  });

  it("rejects a payload missing the required nodeId", () => {
    const { nodeId: _omitted, ...withoutNodeId } = buildValidCapabilityDeclaredPayload();
    expect(RuntimeNodeCapabilityDeclaredPayloadSchema.safeParse(withoutNodeId).success).toBe(false);
  });

  it("rejects an unknown extra key (.strict drift guard)", () => {
    const broken = { ...buildValidCapabilityDeclaredPayload(), bogusField: "nope" };
    expect(RuntimeNodeCapabilityDeclaredPayloadSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects a wrong-type capability (must be a string, not a record)", () => {
    const broken = { ...buildValidCapabilityDeclaredPayload(), capability: { name: "x" } };
    expect(RuntimeNodeCapabilityDeclaredPayloadSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects an oversized capability key (defense-in-depth length cap)", () => {
    const broken = {
      ...buildValidCapabilityDeclaredPayload(),
      capability: "x".repeat(RUNTIME_NODE_CAPABILITY_KEY_MAX_LEN + 1),
    };
    expect(RuntimeNodeCapabilityDeclaredPayloadSchema.safeParse(broken).success).toBe(false);
  });

  it("accepts actor as a string, as null, and omitted; rejects a non-string actor", () => {
    expect(
      RuntimeNodeCapabilityDeclaredPayloadSchema.safeParse(buildValidCapabilityDeclaredPayload())
        .success,
    ).toBe(true);
    expect(
      RuntimeNodeCapabilityDeclaredPayloadSchema.safeParse({
        ...buildValidCapabilityDeclaredPayload(),
        actor: null,
      }).success,
    ).toBe(true);
    const { actor: _omitted, ...withoutActor } = buildValidCapabilityDeclaredPayload();
    expect(RuntimeNodeCapabilityDeclaredPayloadSchema.safeParse(withoutActor).success).toBe(true);
    expect(
      RuntimeNodeCapabilityDeclaredPayloadSchema.safeParse({
        ...buildValidCapabilityDeclaredPayload(),
        actor: 123,
      }).success,
    ).toBe(false);
  });
});

describe("RuntimeNodeCapabilityUpdatedPayloadSchema (C7: reduced base + {capability, previousState, newState})", () => {
  it("parses a fully-valid payload and round-trips (previousState/newState are CapabilityDetails snapshots)", () => {
    const payload = buildValidCapabilityUpdatedPayload();
    const result = RuntimeNodeCapabilityUpdatedPayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      // `previousState`/`newState` here are capability SNAPSHOTS (records), NOT
      // NodeState enum strings — a record value round-trips intact.
      expect(result.data.previousState).toEqual(payload.previousState);
      expect(result.data.newState).toEqual(payload.newState);
    }
  });

  it("rejects a NodeState enum string for newState (it is an opaque record snapshot, not a NodeState)", () => {
    // `newState` is `z.record(...)`, so a NodeState string is the WRONG type here
    // and rejects — proving these fields are capability snapshots, not the
    // lifecycle NodeState transition fields.
    const broken = { ...buildValidCapabilityUpdatedPayload(), newState: "online" };
    expect(RuntimeNodeCapabilityUpdatedPayloadSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects a payload missing the required newState snapshot", () => {
    const { newState: _omitted, ...withoutNewState } = buildValidCapabilityUpdatedPayload();
    expect(RuntimeNodeCapabilityUpdatedPayloadSchema.safeParse(withoutNewState).success).toBe(
      false,
    );
  });

  it("rejects a payload missing the required capability", () => {
    const { capability: _omitted, ...withoutCapability } = buildValidCapabilityUpdatedPayload();
    expect(RuntimeNodeCapabilityUpdatedPayloadSchema.safeParse(withoutCapability).success).toBe(
      false,
    );
  });

  it("rejects a wrong-type capability (must be a string, not a record)", () => {
    // `capability` is inline-duplicated (not factory-shared) from
    // `capability_declared`, so it carries its own type tripwire — mirrors the
    // analogous `capability_declared` test so the two cannot drift apart uncaught.
    const broken = { ...buildValidCapabilityUpdatedPayload(), capability: { name: "x" } };
    expect(RuntimeNodeCapabilityUpdatedPayloadSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects an oversized capability key (defense-in-depth length cap)", () => {
    // Inline-duplicated `capability` cap tripwire — mirrors the
    // `capability_declared` length-cap test (the cap constant is shared, the field
    // declaration is not).
    const broken = {
      ...buildValidCapabilityUpdatedPayload(),
      capability: "x".repeat(RUNTIME_NODE_CAPABILITY_KEY_MAX_LEN + 1),
    };
    expect(RuntimeNodeCapabilityUpdatedPayloadSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects an unknown extra key (.strict drift guard)", () => {
    const broken = { ...buildValidCapabilityUpdatedPayload(), bogusField: "nope" };
    expect(RuntimeNodeCapabilityUpdatedPayloadSchema.safeParse(broken).success).toBe(false);
  });

  it("accepts actor as a string, as null, and omitted; rejects a non-string actor", () => {
    expect(
      RuntimeNodeCapabilityUpdatedPayloadSchema.safeParse(buildValidCapabilityUpdatedPayload())
        .success,
    ).toBe(true);
    expect(
      RuntimeNodeCapabilityUpdatedPayloadSchema.safeParse({
        ...buildValidCapabilityUpdatedPayload(),
        actor: null,
      }).success,
    ).toBe(true);
    const { actor: _omitted, ...withoutActor } = buildValidCapabilityUpdatedPayload();
    expect(RuntimeNodeCapabilityUpdatedPayloadSchema.safeParse(withoutActor).success).toBe(true);
    expect(
      RuntimeNodeCapabilityUpdatedPayloadSchema.safeParse({
        ...buildValidCapabilityUpdatedPayload(),
        actor: 123,
      }).success,
    ).toBe(false);
  });
});

// --------------------------------------------------------------------------
// Plan-003 Phase 5 — T5.0b: `RuntimeNodeRoster` request / entry / response.
// --------------------------------------------------------------------------
//
// Backstops the roster wire shape (api-payload-contracts.md:537-557; registry
// row :566) pinned in Spec-003 §Interfaces And Contracts (2026-06-09
// amendment, lines 90-94): request `{ sessionId }`, the nine-field both-axes
// entry, and response `{ nodes: RuntimeNodeRosterEntry[] }`. Spec coverage:
// Spec-003 line 72 (both health axes carried verbatim — no collapsed scalar),
// line 128 (AC2 — `degraded`/`offline` representable and distinguishable on
// the wire), line 129 (AC3 — multiple nodes coexist in one roster), line 49
// (multiple runtime nodes per session — `nodes[]`). The discriminating enum
// coverage runs BOTH directions: `healthState` ACCEPTING `offline` proves it
// is not mis-wired to the 2-value `RuntimeNodeHealthStateSchema` (which
// excludes `offline`), and `healthState` REJECTING `registering`/`revoked`
// proves it is not mis-wired to the 5-value `NodeStateSchema`.
const buildValidRosterRequest = () => ({
  sessionId: SESSION_ID,
});

const buildValidRosterEntry = () => ({
  nodeId: NODE_ID,
  participantId: PARTICIPANT_ID,
  state: "online" as const,
  healthState: "online" as const,
  lastHeartbeatAt: "2026-06-09T12:00:00.000Z",
  readOnly: false,
  capabilities: { ptyHost: true, maxConcurrentRuns: 4 },
  clientVersion: CLIENT_VERSION,
  attachedAt: "2026-06-09T11:55:00.000Z",
});

describe("RuntimeNodeRosterRequestSchema (T5.0b: sessionId-only query input)", () => {
  it("accepts a request carrying a sessionId", () => {
    expect(RuntimeNodeRosterRequestSchema.safeParse(buildValidRosterRequest()).success).toBe(true);
  });

  it("rejects a request missing sessionId", () => {
    expect(RuntimeNodeRosterRequestSchema.safeParse({}).success).toBe(false);
  });

  it("rejects a non-UUID sessionId", () => {
    expect(RuntimeNodeRosterRequestSchema.safeParse({ sessionId: "not-a-uuid" }).success).toBe(
      false,
    );
  });

  it("rejects an unknown extra key (.strict drift guard)", () => {
    const broken = { ...buildValidRosterRequest(), bogusField: "nope" };
    expect(RuntimeNodeRosterRequestSchema.safeParse(broken).success).toBe(false);
  });
});

describe("RuntimeNodeRosterEntrySchema (T5.0b: nine-field both-axes entry)", () => {
  it("parses a fully-valid entry and round-trips both health axes verbatim", () => {
    const entry = buildValidRosterEntry();
    const result = RuntimeNodeRosterEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.state).toBe("online");
      expect(result.data.healthState).toBe("online");
      expect(result.data.lastHeartbeatAt).toBe(entry.lastHeartbeatAt);
      expect(result.data.readOnly).toBe(false);
      expect(result.data.capabilities).toEqual(entry.capabilities);
    }
  });

  it("parses the pre-first-heartbeat row (healthState: null + lastHeartbeatAt: null)", () => {
    // LEFT-JOIN nullability: no `runtime_node_presence` row exists until the
    // node's first heartbeat lands, so BOTH liveness-axis fields are null.
    const preFirstHeartbeat = {
      ...buildValidRosterEntry(),
      healthState: null,
      lastHeartbeatAt: null,
    };
    expect(RuntimeNodeRosterEntrySchema.safeParse(preFirstHeartbeat).success).toBe(true);
  });

  it.each(["registering", "online", "degraded", "offline", "revoked"])(
    "accepts the slot-axis state value %s (faithful projection — AC2 visibility)",
    (state) => {
      const candidate = { ...buildValidRosterEntry(), state };
      expect(RuntimeNodeRosterEntrySchema.safeParse(candidate).success).toBe(true);
    },
  );

  it.each(["online", "degraded", "offline"])(
    "accepts the liveness-axis healthState value %s (3-value sweep-owned presence enum)",
    (healthState) => {
      // Accepting `offline` is the discriminator against a mis-wire to the
      // 2-value RuntimeNodeHealthStateSchema (the wire self-report excludes it).
      const candidate = { ...buildValidRosterEntry(), healthState };
      expect(RuntimeNodeRosterEntrySchema.safeParse(candidate).success).toBe(true);
    },
  );

  it("accepts an entry whose axes disagree (state degraded + healthState online)", () => {
    // Spec-003 line 72 never-mask stance: the schema imposes NO cross-field
    // constraint between the slot and liveness axes — reconciliation is the
    // client's render-time concern, never the wire's.
    const disagreeingAxes = {
      ...buildValidRosterEntry(),
      state: "degraded" as const,
      healthState: "online" as const,
    };
    expect(RuntimeNodeRosterEntrySchema.safeParse(disagreeingAxes).success).toBe(true);
  });

  it("accepts an online AND readOnly entry (permission axis orthogonal to slot axis)", () => {
    // Same I-003-1 orthogonality as the attach response: a below-floor daemon
    // is ADMITTED (state=online) but read-only — the roster carries the
    // per-row read-time-derived verdict.
    const onlineReadOnly = { ...buildValidRosterEntry(), readOnly: true };
    expect(RuntimeNodeRosterEntrySchema.safeParse(onlineReadOnly).success).toBe(true);
  });

  it("rejects an out-of-enum state", () => {
    const broken = { ...buildValidRosterEntry(), state: "bogus" };
    expect(RuntimeNodeRosterEntrySchema.safeParse(broken).success).toBe(false);
  });

  it("rejects NodeState-only values for healthState (mis-wire guard against the 5-value enum)", () => {
    // `registering`/`revoked` are valid slot-axis NodeState values but are NOT
    // presence-axis values — if `healthState` were mis-wired to the 5-value
    // `NodeStateSchema` these would be accepted.
    for (const slotOnlyValue of ["registering", "revoked"]) {
      const broken = { ...buildValidRosterEntry(), healthState: slotOnlyValue };
      expect(RuntimeNodeRosterEntrySchema.safeParse(broken).success).toBe(false);
    }
  });

  it("rejects an out-of-enum healthState", () => {
    const broken = { ...buildValidRosterEntry(), healthState: "banana" };
    expect(RuntimeNodeRosterEntrySchema.safeParse(broken).success).toBe(false);
  });

  it("rejects an entry OMITTING healthState or lastHeartbeatAt (nullable, NOT optional)", () => {
    // `.nullable()` admits an explicit null but the KEY must be present — the
    // wire always carries both liveness-axis fields (null pre-first-heartbeat).
    const { healthState: _omittedHealth, ...withoutHealthState } = buildValidRosterEntry();
    expect(RuntimeNodeRosterEntrySchema.safeParse(withoutHealthState).success).toBe(false);
    const { lastHeartbeatAt: _omittedBeat, ...withoutLastHeartbeatAt } = buildValidRosterEntry();
    expect(RuntimeNodeRosterEntrySchema.safeParse(withoutLastHeartbeatAt).success).toBe(false);
  });

  it("rejects a non-semver clientVersion (branded MAJOR.MINOR round-trip of the stored TEXT)", () => {
    // The entry round-trips the attach-validated stored `client_version` — a
    // corrupted stored value must fail closed at the read boundary.
    const broken = { ...buildValidRosterEntry(), clientVersion: "latest" };
    expect(RuntimeNodeRosterEntrySchema.safeParse(broken).success).toBe(false);
  });

  it("rejects a non-UUID participantId", () => {
    const broken = { ...buildValidRosterEntry(), participantId: "not-a-uuid" };
    expect(RuntimeNodeRosterEntrySchema.safeParse(broken).success).toBe(false);
  });

  it("rejects a non-boolean readOnly", () => {
    const broken = { ...buildValidRosterEntry(), readOnly: "true" };
    expect(RuntimeNodeRosterEntrySchema.safeParse(broken).success).toBe(false);
  });

  it("rejects a malformed lastHeartbeatAt / attachedAt (z.iso.datetime is load-bearing)", () => {
    expect(
      RuntimeNodeRosterEntrySchema.safeParse({
        ...buildValidRosterEntry(),
        lastHeartbeatAt: "not-a-date",
      }).success,
    ).toBe(false);
    expect(
      RuntimeNodeRosterEntrySchema.safeParse({
        ...buildValidRosterEntry(),
        attachedAt: "not-a-date",
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown extra key (.strict drift guard)", () => {
    const broken = { ...buildValidRosterEntry(), bogusField: "nope" };
    expect(RuntimeNodeRosterEntrySchema.safeParse(broken).success).toBe(false);
  });
});

describe("RuntimeNodeRosterResponseSchema (T5.0b: { nodes: RuntimeNodeRosterEntry[] })", () => {
  it("accepts a multi-entry roster (AC3 — multiple nodes coexist in one session)", () => {
    const roster = {
      nodes: [
        buildValidRosterEntry(),
        {
          ...buildValidRosterEntry(),
          nodeId: "node-daemon-def456",
          state: "offline" as const,
          healthState: "offline" as const,
        },
      ],
    };
    expect(RuntimeNodeRosterResponseSchema.safeParse(roster).success).toBe(true);
  });

  it("accepts an empty roster (a session with no attachments yet)", () => {
    expect(RuntimeNodeRosterResponseSchema.safeParse({ nodes: [] }).success).toBe(true);
  });

  it("rejects a roster containing an invalid entry (element schema is wired)", () => {
    const broken = { nodes: [{ ...buildValidRosterEntry(), state: "bogus" }] };
    expect(RuntimeNodeRosterResponseSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects a non-array nodes value", () => {
    expect(
      RuntimeNodeRosterResponseSchema.safeParse({ nodes: buildValidRosterEntry() }).success,
    ).toBe(false);
  });

  it("rejects a response missing nodes", () => {
    expect(RuntimeNodeRosterResponseSchema.safeParse({}).success).toBe(false);
  });

  it("rejects an unknown extra key (.strict drift guard)", () => {
    const broken = { nodes: [], bogusField: "nope" };
    expect(RuntimeNodeRosterResponseSchema.safeParse(broken).success).toBe(false);
  });
});
