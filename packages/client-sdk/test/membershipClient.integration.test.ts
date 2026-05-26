// Plan-002 Phase 5 T5.1: integration tests for `membershipClient` over the
// daemon JSON-RPC transport (Option A — daemon-as-gateway; single transport).
//
// Spec coverage exercised here (T5.1 axis — the SDK transport boundary):
//   * I1 / Spec-002 AC1 (line 178) — an invited participant joins an active
//     session without resetting active runs. Interpreted at the SDK layer:
//     `acceptInvite` is a PURE membership operation — it issues exactly the
//     `invite.accept` call and returns the schema-validated response, with NO
//     run-state-mutating call on the wire. (Substrate non-disruption — the
//     actual "active runs survive" guarantee — is verified at the services
//     layer per Plan-002 Phase 2 / Phase 3; the SDK cannot reset a run because
//     it never issues a run-touching method.)
//   * I3 / Spec-002 line 87 + AC1 — `ChannelList` returns the bootstrap `main`
//     channel for an existing session. The bootstrap channel id is the
//     deterministic `deriveMainChannelId(sessionId)` (CP-002-7 shared
//     derivation), used in BOTH the scripted response AND the assertion so the
//     test pins the cross-surface invariant, not a daemon-side fabrication.
//   * Unary CRUD smoke — `createInvite` / `revokeInvite` / `updateMembership`
//     round-trip through the mock transport (method-name + schema-validated
//     request sent + response parsed), so NO public method ships untested.
//     Plus a Zod fail-fast assertion: a malformed request is rejected at the
//     SDK boundary with `JsonRpcSchemaError(phase: "params")` BEFORE the wire.
//
// Harness: a MOCK `ClientTransport` + scripted reply table, exactly as
// `sessionClient.integration.test.ts` — fully synchronous, zero external
// state, exercising the same JSON-RPC envelope path the production daemon
// transport uses. (`subscribePresence`'s dedicated test is T5.3's I2, same
// PR — not written here.)
//
// Top-level `describe(...)` blocks are additive-sibling friendly: T5.2
// (control-plane factory) and T5.3 (I2) append siblings without restructuring.

import {
  type ChannelListResponse,
  deriveMainChannelId,
  type InviteId,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponseEnvelope,
  JSONRPC_VERSION,
  type MembershipId,
  MAIN_CHANNEL_NAME,
  type ParticipantId,
  type PresenceUpdate,
  type SessionId,
  SUBSCRIPTION_CANCEL_METHOD,
  SUBSCRIPTION_NOTIFY_METHOD,
  type SubscriptionId,
} from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import {
  createControlPlaneMembershipClient,
  createDaemonMembershipClient,
  NotImplementedAtTier2Error,
} from "../src/membershipClient.js";
import { JsonRpcClient, JsonRpcSchemaError } from "../src/transport/jsonRpcClient.js";
import type { ClientTransport } from "../src/transport/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION_ID: SessionId = "01970000-0000-7000-8000-00000000a001" as SessionId;
const INVITER_PARTICIPANT_ID: ParticipantId =
  "01970000-0000-7000-8000-00000000b001" as ParticipantId;
const INVITED_PARTICIPANT_ID: ParticipantId =
  "01970000-0000-7000-8000-00000000b002" as ParticipantId;
const INVITE_ID: InviteId = "01970000-0000-7000-8000-00000000d001" as InviteId;
const MEMBERSHIP_ID: MembershipId = "01970000-0000-7000-8000-00000000c001" as MembershipId;
// The daemon-issued subscription handle id returned by the scripted
// `presence.subscribe` init ack (T5.3). UUID-shaped so it satisfies the
// `SubscriptionIdSchema` brand the subscribe primitive validates the init
// result against (`jsonRpcClient.ts` `subscribeInitResultSchema`).
const PRESENCE_SUBSCRIPTION_ID: SubscriptionId =
  "01970000-0000-7000-8000-00000000e001" as SubscriptionId;

const PROTOCOL_VERSION = "2026-05-01";

// ---------------------------------------------------------------------------
// Daemon transport harness — in-memory ClientTransport + scripted reply table
// ---------------------------------------------------------------------------
//
// Mirrors the `InMemoryDaemonTransport` pattern in
// `sessionClient.integration.test.ts:124-196`: a programmable response router
// so each method-call can be scripted with a deterministic response shape.
// Synchronous dispatch keeps the tests free of timing-based flake.

interface ScriptedDaemonResponse {
  /** The method name this entry replies to. */
  readonly method: string;
  /** Build the response result given the inbound request. */
  readonly buildResult: (request: JsonRpcRequest) => unknown;
}

interface DaemonHarness {
  readonly transport: InMemoryDaemonTransport;
  readonly client: JsonRpcClient;
  /**
   * Drive a `$/subscription/notify` frame inbound, modeling the daemon's
   * streaming primitive pushing a value to a live subscription. Additive in
   * T5.3 (mirrors `sessionClient.integration.test.ts:182-196`) so the
   * `subscribePresence` stream can be exercised; the unary CRUD / sentinel
   * blocks above never call it.
   */
  readonly notify: (params: unknown) => void;
}

class InMemoryDaemonTransport implements ClientTransport {
  public readonly sentEnvelopes: Array<JsonRpcRequest | JsonRpcNotification> = [];
  readonly #scripted: ScriptedDaemonResponse[];
  #onMessage: ((msg: JsonRpcResponseEnvelope | JsonRpcNotification) => void) | null = null;
  #onClose: ((reason?: Error) => void) | null = null;

  public constructor(scripted: ScriptedDaemonResponse[]) {
    this.#scripted = scripted;
  }

  public send(envelope: JsonRpcRequest | JsonRpcNotification): void {
    this.sentEnvelopes.push(envelope);
    if (!("id" in envelope)) {
      // Notifications carry no id — no response expected. Skip.
      return;
    }
    const reply = this.#scripted.find((entry) => entry.method === envelope.method);
    if (reply === undefined) {
      // Unscripted method — surface as a JSON-RPC error so the test sees the
      // call site that needs scripting (rather than hanging on the pending
      // entry).
      this.dispatchInbound({
        jsonrpc: JSONRPC_VERSION,
        id: envelope.id,
        error: { code: -32601, message: `Unscripted method: ${envelope.method}` },
      });
      return;
    }
    this.dispatchInbound({
      jsonrpc: JSONRPC_VERSION,
      id: envelope.id,
      result: reply.buildResult(envelope),
    });
  }

  public onMessage(handler: (msg: JsonRpcResponseEnvelope | JsonRpcNotification) => void): void {
    this.#onMessage = handler;
  }

  public onClose(handler: (reason?: Error) => void): void {
    this.#onClose = handler;
  }

  public close(): Promise<void> {
    if (this.#onClose !== null) {
      this.#onClose(undefined);
    }
    return Promise.resolve();
  }

  public dispatchInbound(msg: JsonRpcResponseEnvelope | JsonRpcNotification): void {
    if (this.#onMessage === null) {
      throw new Error("dispatchInbound called before onMessage was registered");
    }
    this.#onMessage(msg);
  }
}

function buildDaemonHarness(scripted: ScriptedDaemonResponse[]): DaemonHarness {
  const transport = new InMemoryDaemonTransport(scripted);
  const client = new JsonRpcClient(transport, { protocolVersion: PROTOCOL_VERSION });
  return {
    transport,
    client,
    notify: (params): void => {
      transport.dispatchInbound({
        jsonrpc: JSONRPC_VERSION,
        method: SUBSCRIPTION_NOTIFY_METHOD,
        params,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// I1 — invited participant joins an active session without resetting active
// runs (Spec-002 AC1) — daemon factory, SDK-boundary interpretation
// ---------------------------------------------------------------------------

describe("I1 / Spec-002 AC1 — invited participant joins an active session without resetting active runs (daemon factory)", () => {
  it("daemon factory: createInvite then acceptInvite issues ONLY the membership calls (no run-state-mutating call) and parses the response through InviteAcceptResponseSchema", async () => {
    // Realistic setup: an owner creates an invite, then the invited
    // participant accepts it. The daemon (bridging to the control-plane per
    // Option A) returns the canonical invite-create + invite-accept responses.
    const harness = buildDaemonHarness([
      {
        method: "invite.create",
        buildResult: (): unknown => ({
          inviteId: INVITE_ID,
          token: "v4.local.invite-token-fixture",
          expiresAt: "2026-05-02T12:00:00.000Z",
        }),
      },
      {
        method: "invite.accept",
        buildResult: (): unknown => ({
          // InviteAcceptResponse is SIX fields (invites.ts:262-269): the
          // consumed invite + the activated membership. `state` is the
          // MEMBERSHIP's state (active), not the invite's.
          inviteId: INVITE_ID,
          membershipId: MEMBERSHIP_ID,
          sessionId: SESSION_ID,
          participantId: INVITED_PARTICIPANT_ID,
          role: "collaborator",
          state: "active",
        }),
      },
    ]);
    const sdk = createDaemonMembershipClient(harness.client);

    const created = await sdk.createInvite({
      sessionId: SESSION_ID,
      inviter: INVITER_PARTICIPANT_ID,
      joinMode: "collaborator",
      expiresAt: "2026-05-02T12:00:00.000Z",
    });
    expect(created.inviteId).toBe(INVITE_ID);

    const accepted = await sdk.acceptInvite({ token: created.token });

    // I1 core assertion #1: the accept response round-trips through
    // InviteAcceptResponseSchema — the activated membership references the
    // EXISTING session (no fork) and is `active`.
    expect(accepted.sessionId).toBe(SESSION_ID);
    expect(accepted.membershipId).toBe(MEMBERSHIP_ID);
    expect(accepted.participantId).toBe(INVITED_PARTICIPANT_ID);
    expect(accepted.role).toBe("collaborator");
    expect(accepted.state).toBe("active");

    // I1 core assertion #2 (the load-bearing one): the SDK issued ONLY the two
    // membership calls — `invite.create` and `invite.accept`. The "active runs
    // survive" guarantee at the SDK boundary IS that the membership operation
    // never touches run state. Asserting the EXACT method set the transport saw
    // is exhaustive: any extra call a future regression bolts onto the accept
    // path (a `run.reset`, or anything else) makes this `toEqual` fail.
    const sentMethods = harness.transport.sentEnvelopes.map((e) => e.method);
    expect(sentMethods).toEqual(["invite.create", "invite.accept"]);
  });
});

// ---------------------------------------------------------------------------
// I3 — ChannelList returns the bootstrap main channel for an existing session
// (Spec-002 line 87 + AC1) — daemon factory
// ---------------------------------------------------------------------------

describe("I3 / Spec-002 line 87 + AC1 — ChannelList returns the bootstrap main channel for an existing session (daemon factory)", () => {
  it("daemon factory: listChannels returns a projection whose channels include the deterministically-derived bootstrap main channel", async () => {
    // The bootstrap `main` channel's id is a PURE FUNCTION of the session id
    // (CP-002-7 — deriveMainChannelId is THE shared derivation consumed by both
    // the daemon projector AND the control-plane ChannelList). We derive the
    // expected id with the SAME helper used in the assertion, so the test pins
    // the cross-surface invariant (byte-identical id for a given session)
    // rather than a daemon-side fabrication.
    const mainChannelId = deriveMainChannelId(SESSION_ID);

    const channelListResponse: ChannelListResponse = {
      channels: [
        {
          id: mainChannelId,
          name: MAIN_CHANNEL_NAME,
          state: "active",
          participantCount: 1,
        },
      ],
    };

    const harness = buildDaemonHarness([
      {
        method: "channel.list",
        buildResult: (request): unknown => {
          // Echo back the requested sessionId scoping defensively (the
          // projection is per-session). The response shape is the canonical
          // ChannelListResponse; the bootstrap main channel is the single
          // visible channel for a freshly-bootstrapped session.
          const requested = (request.params as { sessionId: SessionId } | undefined) ?? {
            sessionId: SESSION_ID,
          };
          expect(requested.sessionId).toBe(SESSION_ID);
          return channelListResponse;
        },
      },
    ]);
    const sdk = createDaemonMembershipClient(harness.client);

    const response = await sdk.listChannels({ sessionId: SESSION_ID });

    // I3 core assertion #1: the parsed projection contains the bootstrap main
    // channel, keyed by the deterministically-derived id.
    const main = response.channels.find((channel) => channel.id === mainChannelId);
    expect(main).toBeDefined();
    // I3 core assertion #2: the bootstrap channel carries the canonical `main`
    // name and the `active` lifecycle state.
    expect(main?.name).toBe(MAIN_CHANNEL_NAME);
    expect(main?.state).toBe("active");
    // The wire method was `channel.list` (the SDK-declared, daemon-bridged
    // name per Option A).
    const sentMethods = harness.transport.sentEnvelopes.map((e) => e.method);
    expect(sentMethods).toEqual(["channel.list"]);
  });
});

// ---------------------------------------------------------------------------
// Daemon factory — unary CRUD smoke (createInvite / revokeInvite /
// updateMembership). Mirrors sessionClient's CRUD-smoke describe so NO public
// method ships untested. Per-method assertions: correct method-name + schema-
// validated request sent + response parsed. Plus a Zod fail-fast assertion.
// ---------------------------------------------------------------------------

describe("daemon factory — unary CRUD smoke", () => {
  it("createInvite: sends invite.create with the schema-validated request and parses InviteCreateResponse", async () => {
    const harness = buildDaemonHarness([
      {
        method: "invite.create",
        buildResult: (request): unknown => {
          // Prove the request round-tripped through the wire envelope: the
          // params the transport saw equal the caller's request (already
          // validated by `client.call` against InviteCreateSchema before send).
          expect(request.params).toEqual({
            sessionId: SESSION_ID,
            inviter: INVITER_PARTICIPANT_ID,
            joinMode: "viewer",
            expiresAt: "2026-05-02T12:00:00.000Z",
          });
          return {
            inviteId: INVITE_ID,
            token: "v4.local.created-token",
            expiresAt: "2026-05-02T12:00:00.000Z",
          };
        },
      },
    ]);
    const sdk = createDaemonMembershipClient(harness.client);

    const response = await sdk.createInvite({
      sessionId: SESSION_ID,
      inviter: INVITER_PARTICIPANT_ID,
      joinMode: "viewer",
      expiresAt: "2026-05-02T12:00:00.000Z",
    });

    expect(response.inviteId).toBe(INVITE_ID);
    expect(response.token).toBe("v4.local.created-token");
    expect(response.expiresAt).toBe("2026-05-02T12:00:00.000Z");
    const sent = harness.transport.sentEnvelopes[0];
    expect(sent?.method).toBe("invite.create");
  });

  it("revokeInvite: sends invite.revoke with the schema-validated request and parses InviteRevokeResponse", async () => {
    const harness = buildDaemonHarness([
      {
        method: "invite.revoke",
        buildResult: (request): unknown => {
          expect(request.params).toEqual({
            sessionId: SESSION_ID,
            inviteId: INVITE_ID,
            reason: "owner rescinded",
          });
          // InviteRevokeResponse is STATE-ONLY: {inviteId, state}. `state` is
          // the INVITE's state (`revoked`), not a membership state.
          return { inviteId: INVITE_ID, state: "revoked" };
        },
      },
    ]);
    const sdk = createDaemonMembershipClient(harness.client);

    const response = await sdk.revokeInvite({
      sessionId: SESSION_ID,
      inviteId: INVITE_ID,
      reason: "owner rescinded",
    });

    expect(response.inviteId).toBe(INVITE_ID);
    expect(response.state).toBe("revoked");
    const sent = harness.transport.sentEnvelopes[0];
    expect(sent?.method).toBe("invite.revoke");
  });

  it("updateMembership: sends membership.update with the discriminated-union request (change_role variant) and parses MembershipUpdateResponse", async () => {
    const harness = buildDaemonHarness([
      {
        method: "membership.update",
        buildResult: (request): unknown => {
          // The `change_role` variant carries the non-discriminator `newRole`
          // field — exercising Zod's discriminatedUnion dispatch through to a
          // payload field (the empty-payload suspend/revoke/reactivate variants
          // would not). `client.call` validated this against
          // MembershipUpdateSchema before send.
          expect(request.params).toEqual({
            membershipId: MEMBERSHIP_ID,
            action: "change_role",
            newRole: "collaborator",
          });
          return {
            membershipId: MEMBERSHIP_ID,
            state: "active",
            role: "collaborator",
            updatedAt: "2026-05-02T12:00:00.000Z",
          };
        },
      },
    ]);
    const sdk = createDaemonMembershipClient(harness.client);

    const response = await sdk.updateMembership({
      membershipId: MEMBERSHIP_ID,
      action: "change_role",
      newRole: "collaborator",
    });

    expect(response.membershipId).toBe(MEMBERSHIP_ID);
    expect(response.role).toBe("collaborator");
    expect(response.state).toBe("active");
    expect(response.updatedAt).toBe("2026-05-02T12:00:00.000Z");
    const sent = harness.transport.sentEnvelopes[0];
    expect(sent?.method).toBe("membership.update");
  });

  it("readPresence: sends presence.read (native daemon handler) with the schema-validated request and parses PresenceReadResponse", async () => {
    // `presence.read` is a NATIVE daemon handler (not bridged) — but at the SDK
    // transport boundary it is the same `client.call` envelope. Smoke-cover it
    // so all SIX unary methods ship tested (the seventh, subscribePresence, is
    // T5.3's I2).
    const harness = buildDaemonHarness([
      {
        method: "presence.read",
        buildResult: (request): unknown => {
          expect(request.params).toEqual({ sessionId: SESSION_ID });
          return {
            // `state` is PresenceState ("online" | "idle" | "reconnecting" |
            // "offline"), a DISTINCT enum from MembershipState — the schema
            // rejects a membership-state literal here.
            participants: [
              {
                participantId: INVITER_PARTICIPANT_ID,
                state: "online",
                lastSeen: "2026-05-02T12:00:00.000Z",
              },
            ],
          };
        },
      },
    ]);
    const sdk = createDaemonMembershipClient(harness.client);

    const response = await sdk.readPresence({ sessionId: SESSION_ID });

    expect(response.participants).toHaveLength(1);
    expect(response.participants[0]?.participantId).toBe(INVITER_PARTICIPANT_ID);
    expect(response.participants[0]?.state).toBe("online");
    const sent = harness.transport.sentEnvelopes[0];
    expect(sent?.method).toBe("presence.read");
  });

  it("Zod fail-fast: a malformed createInvite request rejects at the SDK boundary with JsonRpcSchemaError(phase: 'params') BEFORE any wire write", async () => {
    // The bidirectional Zod fail-fast: `client.call` validates the request via
    // the paramsSchema (InviteCreateSchema) BEFORE constructing the wire
    // envelope. A malformed request (here: `joinMode` is not one of the
    // canonical JoinMode literals) fails fast and never reaches the transport.
    const harness = buildDaemonHarness([
      {
        method: "invite.create",
        buildResult: (): unknown => {
          throw new Error("buildResult must not run — the request is rejected before the wire");
        },
      },
    ]);
    const sdk = createDaemonMembershipClient(harness.client);

    // Fail-fast assertion #1: the call rejects with `JsonRpcSchemaError`.
    // (NOT `ZodError` — the SDK's `client.call` wraps the Zod issues in a typed
    // `JsonRpcSchemaError`; the raw `ZodError` is not what surfaces here.)
    const malformedRequest = {
      sessionId: SESSION_ID,
      inviter: INVITER_PARTICIPANT_ID,
      // `"admin"` is NOT a valid JoinMode ("viewer" | "collaborator" |
      // "runtime contributor") — InviteCreateSchema rejects it.
      joinMode: "admin",
      expiresAt: "2026-05-02T12:00:00.000Z",
    } as unknown as Parameters<typeof sdk.createInvite>[0];

    const rejection = await sdk.createInvite(malformedRequest).then(
      () => {
        throw new Error("expected createInvite to reject on malformed joinMode");
      },
      (err: unknown) => err,
    );

    expect(rejection).toBeInstanceOf(JsonRpcSchemaError);
    // Fail-fast assertion #2: the error's `phase` is `"params"` — proving the
    // failure is the caller-side request validation (a caller bug caught before
    // the wire), distinct from a `"result"` server-corruption signal.
    expect((rejection as JsonRpcSchemaError).phase).toBe("params");
    // Fail-fast assertion #3: NO envelope reached the transport — the request
    // never crossed the wire boundary.
    expect(harness.transport.sentEnvelopes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Control-plane factory — deferred-behavior sentinel (Plan-002 T5.2; Spec
// coverage: none). The direct-control-plane membership transport consumes the
// Plan-008-remainder relay (CP-002-1), which does not ship until Tier 5, so
// the factory throws `NotImplementedAtTier2Error` at construction. This block
// verifies the sentinel envelope ONLY — that IS the full extent of T5.2's
// contract (no transport behavior exists to exercise yet).
// ---------------------------------------------------------------------------

describe("control-plane factory — deferred to Tier 5 (NotImplementedAtTier2Error sentinel)", () => {
  // Well-typed throwaway options: the factory throws at construction BEFORE it
  // reads any field, so these values are never used — they exist only to
  // satisfy `ControlPlaneMembershipClientOptions` at the call site.
  const throwawayOptions = {
    fetcher: async (): Promise<Response> => new Response(),
    baseUrl: "https://control-plane.test",
    endpoint: "/trpc",
  };

  it("createControlPlaneMembershipClient throws NotImplementedAtTier2Error at construction", () => {
    expect(() => createControlPlaneMembershipClient(throwawayOptions)).toThrow(
      NotImplementedAtTier2Error,
    );
  });

  it("the thrown sentinel carries name 'NotImplementedAtTier2Error' and a message naming the deferral substrate", () => {
    // Throw-and-capture so we can assert on the concrete instance's `name` and
    // `message` (the `.toThrow(class)` matcher above proves the constructor;
    // this proves the envelope a future reader greps for).
    const thrown = ((): unknown => {
      try {
        createControlPlaneMembershipClient(throwawayOptions);
        return undefined;
      } catch (error: unknown) {
        return error;
      }
    })();

    expect(thrown).toBeInstanceOf(NotImplementedAtTier2Error);
    expect((thrown as NotImplementedAtTier2Error).name).toBe("NotImplementedAtTier2Error");
    // The message must signpost the Tier-5 deferral substrate so a future grep
    // for the relay surfaces this seam.
    expect((thrown as NotImplementedAtTier2Error).message).toMatch(
      /Plan-008-remainder|Tier 5|CP-002-1/,
    );
  });
});

// ---------------------------------------------------------------------------
// I2 / Spec-002 AC2 — Membership remains durable across a presence offline →
// online cycle (Plan-002 I2, line 173; Spec-002 AC2, line 179; worked example
// line 162) — daemon factory.
//
// The load-bearing axis is MEMBERSHIP/PRESENCE SEPARATION, NOT durability-
// enforcement. Durability is the CONTROL-PLANE's guarantee, verified at
// Plan-002 Phases 1/2 + Plan-010; the mock transport here just replays scripted
// responses, so it cannot (and must not) try to enforce that membership
// survives a presence cycle. What it CAN prove at the SDK layer is the
// separation: driving the presence offline→online cycle issues ZERO membership
// mutation — only `presence.subscribe` joins the wire (per I-002-3, presence is
// ephemeral in-memory Yjs Awareness CRDT state; membership is durable
// control-plane storage on a DISJOINT surface).
//
// Why a sequence of distinct `awarenessState` blobs models the cycle: a
// `PresenceUpdate` is `{sessionId, awarenessState: Uint8Array}` — an OPAQUE
// serialized Yjs Awareness CRDT blob (presence.ts:280-292). The presence
// status (online / reconnecting / offline) lives INSIDE that blob; the SDK
// never decodes it. So "presence goes offline and later returns" at the SDK
// boundary IS a stream of `PresenceUpdate` notify frames carrying DISTINCT
// blobs, passed through opaquely. Identical bytes across frames would model
// nothing, so the three blobs MUST differ (`[1]` / `[2]` / `[3]`).
// ---------------------------------------------------------------------------

describe("I2 / Spec-002 AC2 — Membership durable across presence offline → online cycle (membership/presence separation)", () => {
  it("daemon factory: accepting an invite then cycling presence offline→online issues ONLY invite.accept + presence.subscribe (no membership mutation) and yields every PresenceUpdate frame in order", async () => {
    // Distinct, labeled blobs modeling the cycle. The labels self-document the
    // offline→online transition even though the SDK treats each as opaque
    // bytes. They MUST differ — identical bytes would model no transition and
    // the yield-order assertion would not discriminate the frames.
    const ONLINE_AWARENESS = new Uint8Array([1]);
    const OFFLINE_AWARENESS = new Uint8Array([2]);
    const ONLINE_AGAIN_AWARENESS = new Uint8Array([3]);
    const presenceOnline: PresenceUpdate = {
      sessionId: SESSION_ID,
      awarenessState: ONLINE_AWARENESS,
    };
    const presenceOffline: PresenceUpdate = {
      sessionId: SESSION_ID,
      awarenessState: OFFLINE_AWARENESS,
    };
    const presenceOnlineAgain: PresenceUpdate = {
      sessionId: SESSION_ID,
      awarenessState: ONLINE_AGAIN_AWARENESS,
    };

    const harness = buildDaemonHarness([
      {
        method: "invite.accept",
        buildResult: (): unknown => ({
          // The durable membership fact (the bracket/context per Spec-002 line
          // 162): an `InviteAcceptResponse` whose membership is `active`.
          inviteId: INVITE_ID,
          membershipId: MEMBERSHIP_ID,
          sessionId: SESSION_ID,
          participantId: INVITED_PARTICIPANT_ID,
          role: "collaborator",
          state: "active",
        }),
      },
      {
        // The `presence.subscribe` init ack flows through the scripted table
        // like any unary call (precedent: sessionClient.integration.test.ts:
        // 512-515). Returns the daemon-issued subscription handle id.
        method: "presence.subscribe",
        buildResult: (): unknown => ({ subscriptionId: PRESENCE_SUBSCRIPTION_ID }),
      },
      // No `$/subscription/cancel` script needed: this stream ends via
      // transport-close, which the client's close path settles to `completed`
      // locally. The generator's `finally` then calls `subscription.cancel()`,
      // but `#cancelSubscription`'s terminal-status guard returns WITHOUT
      // emitting a wire frame for an already-`completed` subscription — so no
      // cancel envelope reaches the transport here. (Contrast the abort-
      // lifecycle test below, where the listener-fired cancel DOES emit.)
    ]);
    const sdk = createDaemonMembershipClient(harness.client);

    // Step 1 — establish the durable membership fact via the MEMBERSHIP
    // surface. Hold the returned reference for the post-cycle narrative check.
    const membership = await sdk.acceptInvite({ token: "v4.local.invite-token-fixture" });
    expect(membership.membershipId).toBe(MEMBERSHIP_ID);
    expect(membership.state).toBe("active");

    // Step 2 — drive the presence offline→online cycle via `subscribePresence`.
    // `daemonSubscribePresence` is `async function*`: its body does NOT run on
    // construction. We obtain the iterator and prime it with one `.next()` so
    // the generator prelude executes (sends `presence.subscribe`, registers the
    // subscription) BEFORE we deliver notify frames — mirroring the precedent
    // at sessionClient.integration.test.ts:549-581. The prelude up through
    // `client.subscribe()` is synchronous (the harness dispatches the init ack
    // synchronously and `#handleResponse` registers `#subscriptions` before
    // `.next()`'s promise resolves), so firing notifies right after is safe.
    const iter = sdk.subscribePresence({ sessionId: SESSION_ID })[Symbol.asyncIterator]();
    const first = iter.next();

    // Step 3 — deliver three notify frames carrying DISTINCT blobs (the
    // offline→online cycle, opaque to the SDK). Synchronous dispatch parks each
    // value on the subscription queue by the time `notify(...)` returns.
    harness.notify({ subscriptionId: PRESENCE_SUBSCRIPTION_ID, value: presenceOnline });
    harness.notify({ subscriptionId: PRESENCE_SUBSCRIPTION_ID, value: presenceOffline });
    harness.notify({ subscriptionId: PRESENCE_SUBSCRIPTION_ID, value: presenceOnlineAgain });
    // Close the transport so the generator's `for await` terminates (clean
    // close — `reason === undefined` completes the subscription, draining the
    // queued values first).
    await harness.transport.close();

    // Drain: the primed `.next()` already issued; collect it then continue.
    const yielded: PresenceUpdate[] = [];
    let next = await first;
    while (next.done !== true) {
      yielded.push(next.value);
      next = await iter.next();
    }

    // (load-bearing) Exact wire-trace method-set — THE "membership/presence
    // separation" assertion at this layer. The presence cycle (going offline
    // and returning) adds ONLY `presence.subscribe`; it issues ZERO
    // `invite.*` / `membership.*` / `channel.*` mutation. Any future regression
    // that bolts a membership-touching call onto the presence path fails this
    // `toEqual`. (The transport-close teardown emits no `$/subscription/cancel`
    // frame — see the scripted-table note above — so the trace is exactly these
    // two methods.)
    const sentMethods = harness.transport.sentEnvelopes.map((e) => e.method);
    expect(sentMethods).toEqual(["invite.accept", "presence.subscribe"]);

    // (stream mechanics) Full ordered yield sequence — proves
    // `subscribePresence`'s generator handles a MULTI-frame offline→online
    // cycle (the dedicated `subscribePresence` exercise T5.1 deferred to T5.3).
    // `toEqual` deep-compares `Uint8Array` byte content, so the three distinct
    // blobs are discriminated, not just counted.
    expect(yielded).toEqual([presenceOnline, presenceOffline, presenceOnlineAgain]);
    // Belt-and-suspenders on the byte distinctness the cycle hinges on: the
    // labeled blobs surfaced in order, byte-for-byte, NOT collapsed/deduped.
    expect(yielded.map((u) => u.awarenessState[0])).toEqual([1, 2, 3]);

    // (narrative bracket, light) Membership unmutated by the presence cycle —
    // the "membership remains active while presence cycles" narrative (Spec-002
    // line 162). Non-vacuous ONLY because it is paired with the wire-trace
    // assertion above (the mock would echo any scripted value; the wire trace
    // is what proves no mutation was even attempted).
    expect(membership.membershipId).toBe(MEMBERSHIP_ID);
    expect(membership.state).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// `subscribePresence` abort lifecycle — mid-stream AbortSignal teardown.
//
// Closes the deferred `subscribePresence` exercise on the cancellation axis.
// `daemonSubscribePresence` (membershipClient.ts ~265-335) is a SEPARATE
// generator from sessionClient's `daemonSubscribe`, so sessionClient's C1 test
// does NOT transitively cover it — the hardened path is to cover it here. This
// drives the most generator code: the `addEventListener("abort", ...)` wiring,
// the listener-fired `subscription.cancel()`, and the `finally` cleanup.
//
// Determinism with the synchronous harness hinges on scripting the
// `$/subscription/cancel` ack: when `controller.abort()` fires, the listener
// calls `subscription.cancel()`, which emits a `$/subscription/cancel` REQUEST.
// With `{canceled: true}` scripted, that RPC resolves → `completeSubscription`
// → the parked `for await` waiter resolves `undefined` → the generator exits
// CLEANLY (`done: true`). Without the script, the harness's unscripted-method
// path returns `-32601`, the cancel RPC rejects, `completeSubscriptionWithError`
// runs, and the parked `next()` would REJECT — so the ack script is what makes
// the clean-teardown path deterministic.
// ---------------------------------------------------------------------------

describe("subscribePresence abort lifecycle — mid-stream signal abort completes the stream cleanly", () => {
  it("daemon factory: after one PresenceUpdate yields, aborting the signal terminates the async iterable (done, no further values, no throw)", async () => {
    const presenceUpdate: PresenceUpdate = {
      sessionId: SESSION_ID,
      awarenessState: new Uint8Array([1]),
    };

    const harness = buildDaemonHarness([
      {
        method: "presence.subscribe",
        buildResult: (): unknown => ({ subscriptionId: PRESENCE_SUBSCRIPTION_ID }),
      },
      {
        // Scripting the cancel ack is load-bearing for determinism: the
        // abort-listener-fired `subscription.cancel()` emits this RPC, and a
        // `{canceled: true}` ack drives the clean-teardown path (parked
        // `next()` resolves `undefined`) rather than the error path (parked
        // `next()` rejects). See the block header.
        method: SUBSCRIPTION_CANCEL_METHOD,
        buildResult: (): unknown => ({ canceled: true }),
      },
    ]);
    const sdk = createDaemonMembershipClient(harness.client);

    const controller = new AbortController();
    const stream = sdk.subscribePresence({ sessionId: SESSION_ID, signal: controller.signal });
    const iter = stream[Symbol.asyncIterator]();

    // Prime the generator prelude (sends `presence.subscribe`, registers the
    // subscription, wires the abort listener) and deliver ONE frame.
    const first = iter.next();
    harness.notify({ subscriptionId: PRESENCE_SUBSCRIPTION_ID, value: presenceUpdate });

    // Core assertion #1: the established stream yields the delivered frame —
    // proves we exercised the POST-establishment (mid-stream) path, not a
    // pre-abort short-circuit.
    const firstResult = await first;
    expect(firstResult.done).toBe(false);
    expect(firstResult.value).toEqual(presenceUpdate);

    // Abort mid-stream. The `addEventListener("abort")` listener fires
    // synchronously and calls `subscription.cancel()` (emits the scripted
    // `$/subscription/cancel`, which acks `{canceled: true}` and completes the
    // subscription).
    controller.abort();

    // Core assertion #2: the next pull completes the iterator (`done: true`)
    // with no further value — the abort-driven cancel terminated the
    // `for await` cleanly. `await iter.next()` resolving (not rejecting) is the
    // proof the teardown path did NOT throw.
    const afterAbort = await iter.next();
    expect(afterAbort.done).toBe(true);
    expect(afterAbort.value).toBeUndefined();

    // Core assertion #3: the abort issued a `$/subscription/cancel` on the wire
    // (the listener-fired `subscription.cancel()`), confirming the generator's
    // abort wiring ran rather than the stream merely draining empty.
    const sentMethods = harness.transport.sentEnvelopes.map((e) => e.method);
    expect(sentMethods).toEqual(["presence.subscribe", SUBSCRIPTION_CANCEL_METHOD]);
  });
});
