// Plan-002 Phase 6 T6.2 (Tier 2) — renderer ParticipantRoster component.
//
// Spec-002 coverage:
//   • `Spec-002 §Acceptance Criteria` AC1 (an invited participant joins an already active session):
//     this view is the renderer surface that renders the joined-membership
//     roster — every participant the daemon's presence projection reports for
//     the session, including those who joined via the T6.1 invite-accept path.
//   • `Spec-002 §Acceptance Criteria` AC2 ("Membership remains durable when presence goes offline
//     and later returns"): the roster renders members with `state: "offline"`
//     because `offline` is a first-class `PresenceState` (presence.ts:122) — a
//     participant whose presence drops appears with an `offline` indicator
//     rather than vanishing. Whether the Tier-8 daemon projection actually
//     keeps offline members in the `presence.read` result is a daemon-side
//     concern; this Tier-2 renderer-contract surface does NOT reach into
//     `membership.*` to reconstruct durability (that would be a contract
//     expansion outside this task's scope — `membership.*` is intentionally
//     NOT consumed here).
//   • §Interfaces And Contracts ("`PresenceUpdate` … daemon pushes
//     serialized Yjs Awareness state to local clients"; "`PresenceRead`
//     … local clients read current presence state for a session"): the two wire
//     surfaces this view composes. See the Option-C design note below for WHY
//     the two are composed the way they are.
//
// THE DESIGN — presence.read snapshot + presence.subscribe trigger (Option C):
//
//   The plan's Tasks-block shorthand ("render presence indicators via
//   `window.sidekicks.presence.subscribe` async iterator") under-specifies the
//   correct design, exactly as T6.1's shorthand did. The subscribe-only design
//   it implies is WRONG because the `presence.subscribe` stream delivers
//   `PresenceUpdate = { sessionId, awarenessState: Uint8Array }` (presence.ts:280-283)
//   — an OPAQUE serialized Yjs Awareness CRDT delta (`Spec-002 §Interfaces And Contracts`). You
//   cannot render per-participant presence indicators from that blob without a
//   Yjs awareness decoder, and there is NO decode precedent anywhere in the
//   repo. Adding `y-protocols` (or any Yjs decode) to the renderer would be
//   out-of-scope over-engineering against an unspecified awareness-field
//   encoding, for a Tier-1 stub that throws — and it would breach the
//   renderer-untrusted import allowlist below.
//
//   The DECODED per-participant list comes from `presence.read`
//   (`Spec-002 §Interfaces And Contracts`): `daemon.call("presence.read", { sessionId })` →
//   `PresenceReadResponse = { participants: Array<{ participantId, state, lastSeen }> }`
//   (presence.ts:309-329), where `PresenceState = "online" | "idle" |
//   "reconnecting" | "offline"` (presence.ts:122). That decoded shape is what
//   this view renders.
//
//   The data flow:
//     1. On mount: subscribe to `presence.subscribe` FIRST — treat each pushed
//        `PresenceUpdate` as an OPAQUE "something changed" change-signal and
//        RE-INVOKE `presence.read` to refresh the decoded list.
//     2. Then call `presence.read` once for the initial decoded snapshot.
//     3. Unsubscribe on unmount.
//
//   Subscribe-BEFORE-initial-read ordering is deliberate (not the reverse): a
//   presence change landing in the window AFTER the snapshot but BEFORE the
//   subscription is installed would otherwise never be delivered, leaving the
//   roster permanently stale until the next change. Installing the subscription
//   first closes that gap — the worst case becomes a redundant re-read (the
//   subscription fires while the initial read is still in flight), which the
//   out-of-order guard below collapses to the freshest result. The opposite
//   error (a missed update) is unrecoverable without a manual refresh, so we
//   prefer the redundant read.
//
//   `PresenceUpdate` IS A CHANGE-SIGNAL, NOT DISPLAY STATE. We deliberately do
//   NOT accumulate `awarenessState` bytes into React state — `presence.read` is
//   the source of truth for the rendered roster; the subscribe payload only
//   tells us WHEN to re-read. A maintainer's instinct will be to "do something
//   with" the `awarenessState` payload; that instinct is wrong here and this
//   comment pre-empts it. (Tier 8 MAY decode + merge awareness client-side to
//   avoid the re-read round-trip; Tier 2 re-reads `presence.read` on every
//   signal — the chattiness is a noted Tier-8 optimization, not a missed Tier-2
//   concern.)
//
// MOUNT-EFFECT RACE — why the `cancelled` flag IS required here (a deliberate
// REVERSAL of T6.1's no-guard posture):
//
//   T6.1's `InviteAcceptView` correctly OMITS a post-unmount guard because its
//   accept call fires from a CLICK handler — click handlers are not Strict-Mode
//   double-invoked and have no mount-effect race. T6.2 is different: the
//   initial `presence.read` (and every subscribe-triggered re-read) is an async
//   call originating inside a MOUNT `useEffect`. React StrictMode synthetically
//   double-invokes effects (mount → unmount → remount), so the first effect
//   run's pending `presence.read` can resolve AFTER its cleanup ran. That is the
//   genuine `SessionBootstrap` mount-effect race. We use the `SessionBootstrap`
//   pattern exactly: a closure-scoped `let cancelled = false` at the top of the
//   effect, flipped to `true` in cleanup, checked before every `setState`. We
//   deliberately do NOT use a `useRef` mount-tracker — the per-effect-run
//   closure `let` is correct precisely because it RESETS each effect run, which
//   is what neutralizes the StrictMode double-invoke (a single ref persisting
//   across both runs would not). A future reader should NOT "harmonize" this
//   guard away to match `InviteAcceptView`: the difference (mount-effect race
//   vs click no-op) is load-bearing. (`main.tsx:13` confirms no `StrictMode`
//   wrapper at Tier 1 yet; the guard is forward-defense for the Tier-8
//   StrictMode opt-in and is harmless until then.)
//
// Tier-2 routing-scope note: no router / deep-link handler exists yet to supply
// the `sessionId` prop in production — that wiring is a later Plan-023 concern.
// This view is an independently-renderable, testable component with a clear
// prop contract; the T6.3 component tests render it with a mock `sessionId` + a
// mock `window.sidekicks` bridge. A reviewer should NOT flag "this is never
// rendered in production" — production routing is intentionally out of T6.2's
// scope.
//
// Renderer-untrusted boundary (Spec-023 §Trust Stance) — this file imports
// ONLY:
//   • `react` — the renderer's UI engine; explicitly allowed.
//   • Type-only from `@ai-sidekicks/contracts` — the contracts package is
//     renderer-safe (no `node:*`, `electron`, or `fs`/`path`/`process` runtime
//     imports); the type-only form emits no JS runtime import at all, so only
//     the type-graph view of the wire shapes reaches the renderer.
// No `electron`, no `node:*`, no `./src/main/**`, no `./src/preload/**` —
// statically enforced via the `no-restricted-imports` rule in
// apps/desktop/eslint.config.mjs. (The `@ai-sidekicks/client-sdk` ban is
// structural since Plan-023 T-023p-1C-1 removed the package from this app's
// manifest — the specifier no longer resolves here, per the SessionBootstrap
// header.)

import { useEffect, useState } from "react";

import type {
  PresenceReadRequest,
  PresenceReadResponse,
  PresenceReadResponseParticipant,
  PresenceUpdate,
  SessionId,
  Unsubscribe,
} from "@ai-sidekicks/contracts";

// The `window.sidekicks` ambient type lives in the renderer-wide
// `sidekicks-bridge.d.ts` (T6.0; part of the renderer typecheck graph via its
// `include`), so `window.sidekicks` below is `SidekicksBridge`-typed without an
// import here. The bridge exposes exactly six GENERIC capability surfaces
// (Spec-023; desktop-bridge.ts:265-314) — there is no `presence` namespace.
// The plan's Tasks-block shorthand `window.sidekicks.presence.subscribe` is
// non-binding prose; the real transport is the generic `daemon.call(...)` /
// `daemon.subscribe(...)` pair below.

// Wire method/event names. DAEMON-AS-GATEWAY (Option A, ADR-008): the renderer
// speaks ONE transport (JSON-RPC to the local daemon); the daemon proxies
// `presence.*` server-side. We do NOT extend the bridge (extending its
// intentional generic design contradicts Spec-023 + Plan-023 contract
// ownership). Mirrors the shipped SDK precedent `membershipClient.ts:164-165`
// (`PRESENCE_METHOD_READ` / `PRESENCE_METHOD_SUBSCRIBE`) and T6.1's
// `INVITE_ACCEPT_METHOD`.
//
// DECIDED bridge-contract gap — `presence.subscribe` request params have no
// channel today. The daemon REQUIRES a `{ sessionId }` request body for
// `presence.subscribe` (`PresenceSubscribeRequestSchema` at
// `packages/contracts/src/presence.ts` is `z.object({ sessionId }).strict()`;
// the runtime-daemon handler validates it before dispatch; the client SDK's
// `subscribePresence` already sends it). But the generic bridge surface
// `daemon.subscribe<E>(event, handler)` (desktop-bridge.ts:269-272) carries
// only an event name + handler — NO params channel — so this view CANNOT pass
// `{ sessionId }` on subscribe and instead carries the session scope into the
// `presence.read` re-reads alone. This is a DECIDED gap, not an open question:
// its resolution is PINNED in Spec-023 §Preload Bridge Contract (the
// daemon-subscribe surface MUST carry each subscription's request params; the
// param-less signature is a Tier-1 placeholder), and the signature SHAPE is
// owned by Plan-007 / Plan-008, which narrow `DaemonEvent` / `DaemonParams` /
// `DaemonEventPayload` across all daemon methods at once. The renderer's
// subscribe call here is already maximally correct against the current Tier-1
// stub, so THIS PR owes no further renderer change. When the params channel
// lands, the Plan-007 / Plan-008 wiring task threads `{ sessionId }` through
// this subscribe (the daemon enforces it per `PresenceSubscribeRequestSchema`);
// that future change is owned by that task, not deferred from here.
const PRESENCE_READ_METHOD = "presence.read";
const PRESENCE_SUBSCRIBE_EVENT = "presence.subscribe";

/**
 * Props for {@link ParticipantRoster}.
 *
 * `sessionId` is the branded {@link SessionId} of the session whose roster to
 * render. It matches `PresenceReadRequest.sessionId`, so `{ sessionId }`
 * constructs a valid `presence.read` request with no cast. The id arrives as a
 * prop (supplied by a future Plan-023 router/deep-link; mocked in the T6.3
 * tests), not from any renderer-side discovery.
 */
export interface ParticipantRosterProps {
  sessionId: SessionId;
}

// Discriminated-union view state. Mount-triggered, so it STARTS in `loading`
// (there is no button — the read fires on mount, like `SessionBootstrap`'s
// initial `pending`; unlike T6.1's `idle`, which exists only because that view
// is click-triggered). Each variant maps 1:1 to a rendered `<section>` branch
// below, so the render is a total function over the union.
//
// IMPORTANT (no-flicker contract): `loading` is set in only two places, both
// RENDER-PHASE — the `useState` initializer (MOUNT) and the `previousSessionId`
// guard at the top of the component body (every `sessionId` CHANGE, so a genuine
// session switch shows loading, not the prior session's stale roster, with no
// stale frame — see that block). It is NOT set on a same-session
// subscribe-triggered re-read: `refreshSnapshot` setStates ONLY to `loaded` or
// `error`, never `loading`, so a re-read updates the participant list IN PLACE
// (`loaded → loaded`, or `loaded → error` on re-read failure) and never flashes
// back to the loading branch. The distinction is load-bearing: identity-level
// loading (mount + sessionId change) is correct UX; re-read-level loading would
// flicker on every presence push.
type RosterState =
  | { kind: "loading" }
  | { kind: "loaded"; participants: PresenceReadResponseParticipant[] }
  | { kind: "error"; error: Error };

/**
 * Renders the live participant roster for a session: a loading indicator while
 * the initial snapshot is in flight, one row per participant (id + presence
 * state + last-seen) once loaded, or the error envelope on failure. The roster
 * refreshes itself as presence changes — see the Option-C design note in the
 * file header for the presence.read-snapshot + presence.subscribe-trigger flow.
 *
 * State primitive — manual `useState` discriminated union, NOT React 19
 * `useTransition` / `useActionState`. The trade-off matches the shipped
 * `SessionBootstrap` / T6.1 precedent (keeps the renderer consumers
 * structurally consistent) and fits the Tier-1 sync-throw normalization, which
 * needs explicit `try/catch` around the bridge calls.
 */
export function ParticipantRoster({ sessionId }: ParticipantRosterProps): React.JSX.Element {
  const [rosterState, setRosterState] = useState<RosterState>({ kind: "loading" });

  // Session-identity prop reset (React's "Adjusting some state when a prop
  // changes" pattern — react.dev "You Might Not Need an Effect"; the SAME
  // render-phase mechanism `InviteAcceptView` uses for its `token`). This is a
  // render-phase setState React applies by DISCARDING the in-progress render
  // output and re-rendering BEFORE it commits to the DOM — NOT an effect.
  //
  // SCOPE — what this reset covers, and what completes it:
  //   • It covers a parent reusing this mounted instance across a `sessionId`
  //     change (a future Plan-023 router swapping the rendered session). On the
  //     change it resets to `loading` so the prior session's `loaded` roster
  //     never reaches the DOM. Doing this render-phase (not in the effect, which
  //     runs only AFTER React commits) is what makes "shows loading, not the
  //     prior session's roster" TRUE rather than aspirational: an effect-body
  //     reset would let the stale roster paint for one frame before flipping.
  //   • The COMPLETE fix for instance reuse is the Tier-8 parent keying the
  //     roster per session (`key={sessionId}`), which DISCARDS the prior instance
  //     on a session change — React's canonical "reset all state on an
  //     identity-prop change" mechanism (react.dev "Preserving and Resetting
  //     State"). This render-phase reset is the narrower fallback until that
  //     keying lands.
  //
  // It touches ONLY `rosterState`: the effect-scoped sequence counter and the
  // subscribe/read logic live inside the effect (which re-runs on the same
  // `[sessionId]` change) and are unperturbed. `refreshSnapshot` still never
  // setStates to `loading`, so same-session subscribe-triggered re-reads remain
  // flicker-free (the no-flicker contract in the `RosterState` comment).
  const [previousSessionId, setPreviousSessionId] = useState(sessionId);
  if (sessionId !== previousSessionId) {
    setPreviousSessionId(sessionId);
    setRosterState({ kind: "loading" });
  }

  useEffect(() => {
    // Strict-mode-safe mount (see the file-header MOUNT-EFFECT RACE note). The
    // `cancelled` flag, flipped in cleanup, makes any in-flight `presence.read`
    // resolution (initial OR subscribe-triggered) a no-op after this effect run
    // is torn down — so we never `setState` on an unmounted (or about-to-be-
    // remounted) tree under StrictMode's double-invoke. The closure-scoped
    // `let` is intentional: it RESETS per effect run, which is what neutralizes
    // the double-invoke.
    let cancelled = false;

    // Effect-scoped monotonic read sequence — the out-of-order guard. Multiple
    // `refreshSnapshot()` calls can be IN FLIGHT at once (rapid subscribe pushes
    // each kick off a `presence.read`), and the bridge gives no ordering
    // guarantee on resolution. The `cancelled` flag guards UNMOUNT, not
    // concurrency: without this counter an OLDER `presence.read` resolving AFTER
    // a NEWER one would overwrite fresh data with stale. Each `refreshSnapshot`
    // captures the value AFTER incrementing it; a resolution whose captured
    // sequence is no longer the latest bails without setState. It RESETS per
    // effect run (closure-scoped `let`, same rationale as `cancelled`) so a
    // session switch starts a fresh sequence.
    let latestRequestSequence = 0;

    // Held so cleanup can release the daemon subscription. `undefined` until the
    // synchronous `subscribePresence(...)` below succeeds — at Tier 1 it throws
    // synchronously, so `unsubscribe` stays `undefined` and `unsubscribe?.()`
    // in cleanup is a safe no-op.
    let unsubscribe: Unsubscribe | undefined;

    // (Loading reset lives render-phase at the top of the component body, NOT
    // here — see the `previousSessionId` block. An effect-body reset runs only
    // AFTER React commits, so a reused instance would paint the prior session's
    // `loaded` roster for one frame before flipping to `loading`.)
    //
    // `DaemonMethod` brand cast (Plan-007 follow-up), TIGHTENED to the real
    // contract types. The bridge declares
    // `daemon.call<M extends DaemonMethod>(method: M, params: DaemonParams<M>):
    // Promise<DaemonResult<M>>` where `DaemonMethod` is a `never`-shaped brand
    // at Tier 1 (desktop-bridge.ts:62) — no string literal is structurally
    // assignable to it until Plan-007 narrows the brand to a string-literal
    // union of real method names. The method-name string stays loosely `string`
    // (the genuinely untypeable part until Plan-007 lands), but unlike
    // `SessionBootstrap` (which casts params AND return to `unknown`), we pin
    // params → `PresenceReadRequest` and return → `Promise<PresenceReadResponse>`.
    // That localizes the Plan-007 brand bypass to ONE documented cast, keeps the
    // request object type-checked at the call site, and means the resolved value
    // needs NO downstream `as PresenceReadResponse` cast. A deliberate
    // IMPROVEMENT over `SessionBootstrap`'s loose `unknown`/`unknown`;
    // `SessionBootstrap` should adopt the same tightening later (out of scope).
    const readPresence = window.sidekicks.daemon.call as (
      method: string,
      params: PresenceReadRequest,
    ) => Promise<PresenceReadResponse>;

    // `DaemonEvent` brand cast (Plan-007 follow-up), same posture as the
    // `readPresence` cast above and tightened identically. The bridge declares
    // `daemon.subscribe<E extends DaemonEvent>(event: E, handler: (payload:
    // DaemonEventPayload<E>) => void): Unsubscribe` where `DaemonEvent` is a
    // `never`-shaped brand (desktop-bridge.ts:81) and `DaemonEventPayload<E>` is
    // `unknown` (desktop-bridge.ts:87). We pin the event name to `string` (the
    // untypeable part) and the handler payload → `PresenceUpdate`, so the
    // change-signal payload is type-checked without a `DaemonEventPayload`
    // cast. This single brand bypass lifts when Plan-007 lands the narrowed
    // `DaemonEvent` union + event-to-payload map.
    const subscribePresence = window.sidekicks.daemon.subscribe as (
      event: string,
      handler: (payload: PresenceUpdate) => void,
    ) => Unsubscribe;

    // Shared decoded-snapshot read. Used for BOTH the initial read and every
    // subscribe-triggered refresh. The async-IIFE shape funnels a SYNCHRONOUS
    // Tier-1 stub throw (`() => tier1Throw("daemon.call")`, desktop-bridge.ts:349)
    // AND a future async rejection into the same `catch`: a bare
    // `readPresence(...).then(...).catch(...)` would evaluate `readPresence(...)`
    // first, and the sync throw would escape before `.then` is reached. This
    // function NEVER setStates to `{ kind: "loading" }` — it transitions only to
    // `loaded` or `error`, so subscribe-triggered re-reads never flash back to
    // the loading branch (the no-flicker contract from the `RosterState`
    // comment).
    //
    // Each invocation captures a fresh `requestSequence` AFTER incrementing the
    // effect-scoped counter, so the LATEST in-flight read always owns the
    // highest sequence. Both the success and the error branch bail when EITHER
    // the effect was torn down (`cancelled`) OR a newer read has since started
    // (`requestSequence !== latestRequestSequence`) — the two guards are
    // independent (unmount vs out-of-order) and both are required.
    const refreshSnapshot = (): void => {
      const requestSequence = ++latestRequestSequence;
      void (async () => {
        try {
          const presenceResponse = await readPresence(PRESENCE_READ_METHOD, { sessionId });
          if (cancelled || requestSequence !== latestRequestSequence) return;
          // No `as PresenceReadResponse` cast — the tightened brand cast above
          // already types `readPresence`'s resolved value.
          setRosterState({ kind: "loaded", participants: presenceResponse.participants });
        } catch (bridgeError: unknown) {
          if (cancelled || requestSequence !== latestRequestSequence) return;
          // Tier-1 production branch: every Tier-1 bridge method throws
          // `NotImplementedAtTier1Error` (desktop-bridge.ts `createTier1Bridge`).
          // We do not narrow on `instanceof` — any `Error` shape renders the
          // same envelope; non-`Error` rejections are wrapped so the render
          // branch always holds a real `Error` instance. A re-read failure
          // flips the whole roster to `error` (the Tier-2 posture, matching the
          // initial-read failure); a resilient "keep last snapshot, log the
          // error" is a Tier-8 polish, not a Tier-2 requirement.
          const normalizedError =
            bridgeError instanceof Error ? bridgeError : new Error(String(bridgeError));
          setRosterState({ kind: "error", error: normalizedError });
        }
      })();
    };

    // 1. Subscribe to the change-signal stream FIRST, BEFORE the initial read.
    //    A presence change landing after the snapshot but before the
    //    subscription is installed would otherwise be lost, leaving the roster
    //    stale (see the file-header data-flow note). Installing first means the
    //    worst case is a redundant re-read the out-of-order guard collapses.
    //
    //    The synchronous `subscribePresence(...)` call gets its OWN `try/catch`
    //    because at Tier 1 it throws synchronously
    //    (`() => tier1Throw("daemon.subscribe")`, desktop-bridge.ts:350); an
    //    uncaught throw here would crash the effect callback (React does not catch
    //    effect-callback throws) and strand the view. On the throw we drive the
    //    error state, same envelope as the read. The initial `refreshSnapshot()`
    //    call sits INSIDE this `try` (step 2 below) so a subscribe-throw skips it
    //    rather than clobbering the error with a channel-less snapshot; a READ
    //    failure is still owned by the IIFE's own `catch`, not this one (the
    //    async IIFE never throws synchronously out of the call).
    //
    //    The handler ITSELF needs sync-throw defense too: at Tier 8 the bridge
    //    will invoke it with real signals, and it re-invokes `readPresence`
    //    (the same sync-throwing async shape). The handler delegates to
    //    `refreshSnapshot`, whose async-IIFE already funnels sync throws + async
    //    rejections to its `catch` — and which closes over `cancelled` + the
    //    sequence guard, so a re-read kicked off the instant before unmount
    //    cannot `setState` after cleanup. We do NOT consume the `PresenceUpdate`
    //    payload: it is an opaque change-signal (see the header), so the handler
    //    simply re-reads.
    try {
      unsubscribe = subscribePresence(PRESENCE_SUBSCRIBE_EVENT, () => {
        refreshSnapshot();
      });

      // 2. Initial decoded snapshot — INSIDE this `try`, AFTER the subscribe
      //    assignment, so it runs ONLY when the subscription actually installed.
      //    Two reasons it is gated on subscribe success, not unconditional:
      //      • Ordering: running after the subscribe means no presence change can
      //        slip through the gap between snapshot and subscribe (see comment 1).
      //      • Honesty: if `subscribePresence` threw, control jumps to the `catch`
      //        below (which set `error`) and SKIPS this read. An unconditional read
      //        here would, on a subscribe-throw + read-success, CLOBBER that `error`
      //        with `loaded` — stranding the user on a static snapshot with NO live
      //        channel that silently never updates. A failed subscribe means no live
      //        channel, so `error` is the honest Tier-2 state (the same posture as a
      //        read-failure in `refreshSnapshot`'s `catch`), not a stale `loaded`.
      //    `refreshSnapshot` is the async-IIFE shape, so it never throws
      //    synchronously OUT of this call — this `try` cannot swallow a read error;
      //    read failures are owned by the IIFE's own `catch`.
      refreshSnapshot();
    } catch (subscribeError: unknown) {
      if (!cancelled) {
        const normalizedError =
          subscribeError instanceof Error ? subscribeError : new Error(String(subscribeError));
        setRosterState({ kind: "error", error: normalizedError });
      }
    }

    return () => {
      cancelled = true;
      // Idempotent per the `Unsubscribe` contract (desktop-bridge.ts:118);
      // `?.()` no-ops when the Tier-1 subscribe threw before assigning.
      unsubscribe?.();
    };
    // `[sessionId]` (not `[]`): the effect reads and subscribes for a specific
    // session, so changing the prop must tear down the old subscription and
    // re-run for the new one. `SessionId` is a string brand, so referential
    // equality holds and the effect does not re-run on unrelated re-renders.
  }, [sessionId]);

  if (rosterState.kind === "loading") {
    // `aria-busy` announces the in-flight initial snapshot to assistive tech.
    return (
      <section aria-label="participant-roster-loading" aria-busy="true">
        <p>Loading participants…</p>
      </section>
    );
  }

  if (rosterState.kind === "loaded") {
    // One row per participant: id + presence state + last-seen. A participant
    // with `state: "offline"` renders here too (Spec-002 AC2 durability) — the
    // offline indicator, not a disappearance, is the correct surface.
    return (
      <section aria-label="participant-roster-loaded">
        <ul>
          {rosterState.participants.map((participant) => (
            <li key={participant.participantId}>
              <span>participant id: {participant.participantId}</span>
              <span>presence: {participant.state}</span>
              <span>last seen: {participant.lastSeen}</span>
            </li>
          ))}
        </ul>
      </section>
    );
  }

  // role="alert" so assistive tech announces the failure.
  return (
    <section aria-label="participant-roster-error" role="alert">
      <p>
        {rosterState.error.name}: {rosterState.error.message}
      </p>
    </section>
  );
}
