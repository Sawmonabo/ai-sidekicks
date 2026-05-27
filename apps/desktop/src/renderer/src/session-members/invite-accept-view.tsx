// Plan-002 Phase 6 T6.1 (Tier 2) — renderer InviteAcceptView component.
//
// Spec-002 coverage:
//   • §Interfaces And Contracts line 81 ("`InviteAccept` must create active
//     membership and emit participant join events") + §AC1 (line 178, an
//     invited participant joins an active session): this view is the renderer
//     surface that issues the `invite.accept` wire call and renders the
//     resulting active membership (sessionId, role, membership state,
//     membershipId) the accept path returns.
//   • §Token Security Properties (lines 107-113): the view carries ONLY the
//     opaque PASETO v4.local token (the `token` prop) into the request. Token
//     decoding, signature verification, expiry enforcement, and single-use
//     atomicity are the control-plane service's job, never the renderer's —
//     the renderer is the untrusted surface (Spec-023 §Trust Stance).
//
// TIER-2 INTERIM IMPLEMENTATION — this view is the interim renderer surface for
// invite acceptance. The end-state contract is now PINNED in Spec-023 §Deep-Link
// Invite Flow; this view deviates from it on two axes that are deferred to the
// Tier-8 runtime WIRING, not to any future CONTRACT decision. A reviewer should
// read this view as the interim implementation of a settled target, not as an
// open contract question.
//
//   (a) As-built Tier-2 posture (what ships now). The renderer receives the
//       opaque `token` as a prop and issues the daemon-as-gateway
//       `daemon.call("invite.accept", { token })`; the view runs an
//       idle → pending → resolved/rejected state machine. The explicit Accept
//       button is a DELIBERATE, USER-INITIATED trigger, not a mount side-effect
//       — auto-accepting on mount would silently consume a single-use invite on
//       route-load (the wrong UX). That explicit-confirmation UX is now BLESSED
//       by the amended §Deep-Link property (b): it is the TARGET behavior, not a
//       divergence to be undone. (It is also the deliberate divergence from
//       `SessionBootstrap`, whose mount-trigger fits "create a session as the
//       app loads" but would be wrong for "accept an invite as a route renders";
//       it is why this view has an `idle` state that `SessionBootstrap` lacks —
//       a mount-triggered component starts `pending`, a button-triggered one
//       starts `idle`, the pre-click prompt.) The posture is chosen for
//       independent renderability + testability: this is a self-contained
//       component with a clear prop contract, and the T6.3 component tests
//       render it with a mock `token` + a mock `window.sidekicks` bridge.
//   (b) Pinned target (amended Spec-023 §Deep-Link Invite Flow). The MAIN
//       process confines the invite token, hands the renderer an opaque
//       reference + display metadata via a bridge event, the renderer surfaces
//       the explicit confirmation (THIS view's Accept UX realizes §Deep-Link
//       property (b)), and the main process calls `acceptInvite(token)` on
//       confirm — "the raw invite token never crosses the bridge to the
//       renderer". The interim posture deviates on exactly TWO axes, both
//       runtime-wiring concerns: (1) token confinement — the renderer holds the
//       raw `token` prop today vs a main-confined opaque reference at the target;
//       (2) acceptance mechanism — the renderer issues
//       `daemon.call("invite.accept", { token })` today vs renderer-confirms-
//       via-opaque-reference + main-process-accepts at the target.
//   (c) Pay-off trigger. Plan-023 Tier 8 ships the runtime wiring: the
//       `sidekicks://invite/<token>` protocol handler + the bridge-event IPC
//       dispatcher + the opaque-reference lifecycle (the SAME Tier-8 gate as
//       T6.4's two-client smoke). At that reshape, this view drops the raw
//       `token` prop for the opaque reference + display metadata; the
//       explicit-confirmation UX stays. The contract is DECIDED; only the wiring
//       is deferred.
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
// by-convention at Tier 1; lint will not catch it until a renderer-targeted
// entry lands at the Plan-023 Tier 8 hoist, per the SessionBootstrap header.)

import { useState } from "react";

import type { InviteAccept, InviteAcceptResponse } from "@ai-sidekicks/contracts";

// The `window.sidekicks` ambient type lives in the renderer-wide
// `sidekicks-bridge.d.ts` (T6.0; part of both renderer typecheck graphs via
// their respective `include`s), so `window.sidekicks` below is
// `SidekicksBridge`-typed without an import here. The bridge exposes exactly
// six GENERIC capability surfaces (Spec-023; desktop-bridge.ts:265-314) — there
// is no `invites`/`presence` namespace. The plan's Tasks-block shorthand
// `window.sidekicks.invites.accept` (line 384) is non-binding prose; the real
// transport is the unary `daemon.call("invite.accept", …)` below.

// The wire method name. DAEMON-AS-GATEWAY (Option A, ADR-008): the renderer
// speaks ONE transport (JSON-RPC to the local daemon); the daemon proxies
// `invite.*` to the control-plane server-side. We do NOT use `controlPlane.call`
// (that would be a second seam the local client deliberately does not open) and
// we do NOT extend the bridge (extending its intentional generic design
// contradicts Spec-023 + Plan-023 contract ownership). This mirrors the shipped
// SDK precedent `membershipClient.ts:160,225` (`INVITE_METHOD_ACCEPT`).
const INVITE_ACCEPT_METHOD = "invite.accept";

/**
 * Props for {@link InviteAcceptView}.
 *
 * `token` is a plain `string` (matching `InviteAccept.token`) — the opaque
 * PASETO v4.local invite token delivered out-of-band via a shareable link, NOT
 * a branded id and NOT a user-hand-typed value. This view therefore renders no
 * token-entry form; the token always arrives as a prop.
 */
export interface InviteAcceptViewProps {
  token: string;
}

// Discriminated-union view state — mirrors `SessionBootstrap`'s `BootstrapState`
// shape, with an added `idle` initial state because this view is button- (not
// mount-) triggered. Each variant maps 1:1 to a rendered `<section>` branch
// below, so the render is a total function over the union.
type AcceptState =
  | { kind: "idle" } // pre-click — render the Accept prompt + button
  | { kind: "pending" } // accept call in flight
  | { kind: "resolved"; value: InviteAcceptResponse }
  | { kind: "rejected"; error: Error };

/**
 * Renders the invite-acceptance confirmation surface: an Accept prompt, an
 * in-flight indicator, the joined-membership facts on success, or the error
 * envelope on failure.
 *
 * State primitive — manual `useState` discriminated union, NOT React 19
 * `useTransition` / `useActionState`. The trade-off is deliberate: (a) it
 * matches the shipped `SessionBootstrap` precedent, keeping the two renderer
 * consumers structurally consistent; and (b) the Tier-1 sync-throw
 * normalization (see the click handler) needs an explicit `try/catch` around
 * the `await`, which `useActionState`'s form-bound action model fits awkwardly.
 * This is pattern-correctness for the "Tier-1 stub throws synchronously"
 * constraint, not a reflexive avoidance of the React 19 primitives.
 */
export function InviteAcceptView({ token }: InviteAcceptViewProps): React.JSX.Element {
  const [acceptState, setAcceptState] = useState<AcceptState>({ kind: "idle" });

  // Token-identity prop reset (React's "Adjusting some state when a prop
  // changes" pattern — react.dev "You Might Not Need an Effect"). This is the
  // render-phase setState React APPLIES BEFORE the browser repaints, NOT a
  // `useEffect`: when a parent reuses this mounted instance with a DIFFERENT
  // `token` (e.g. a future deep-link/router renders the same `<InviteAcceptView>`
  // for a new invite), `useState({ kind: "idle" })` does not re-run, so without
  // this reset `acceptState` would keep the PRIOR token's branch.
  //
  // SCOPE — what this reset covers, and what completes it:
  //   • It covers the POST-SETTLED reuse case: a parent reuses the instance with
  //     a new `token` AFTER the prior accept already SETTLED (resolved/rejected).
  //     Without the reset the new invite would show the prior token's
  //     `resolved`/`rejected` branch — stale membership and no Accept button;
  //     storing the last-seen `token` and resetting to `idle` on a mismatch
  //     re-prompts for the new invite. (No effect, so no extra render-to-screen —
  //     the reset folds into the current render.)
  //   • The COMPLETE fix for instance reuse — POST-SETTLED *and* the
  //     mid-accept-in-flight race (handled in the click-handler note below) — is
  //     the Tier-8 parent keying this view per invite (`key={token-derived}`),
  //     which DISCARDS the prior instance on a token change. That is React's
  //     canonical "reset all state on an identity-prop change" mechanism
  //     (react.dev "Preserving and Resetting State"). This render-phase reset is
  //     the narrower fallback for the post-settled case until that keying lands;
  //     it is NOT a claim of full standalone correctness across the in-flight
  //     race (see the click-handler note for why that race is harmless anyway).
  const [previousToken, setPreviousToken] = useState(token);
  if (token !== previousToken) {
    setPreviousToken(token);
    setAcceptState({ kind: "idle" });
  }

  // Sync click handler (React's `onClick` contract). The async accept work runs
  // in a void IIFE inside it — the same shape SessionBootstrap uses for its
  // mount effect (`void (async () => { … })()`).
  //
  // No post-unmount `setState` guard (no `cancelled` flag, no `AbortController`):
  //   • React 18/19 made a `setState` on an unmounted component a silent no-op
  //     (the legacy "can't perform a React state update on an unmounted
  //     component" warning was removed), so the unguarded `setAcceptState` after
  //     the `await` is already safe.
  //   • `onClick` handlers are NOT Strict-Mode double-invoked (only renders and
  //     effects re-run), so there is no double-fire on this path to guard.
  // SessionBootstrap's `cancelled` flag guards a MOUNT-EFFECT double-invocation
  // race, which simply does not arise on a click path. (`main.tsx` confirms no
  // `StrictMode` wrapper at Tier 1; the no-guard form stays correct at Tier 8
  // when StrictMode lands, since the no-op holds under StrictMode too.)
  //
  // This IIFE also has NO in-flight cancellation (no `cancelled`/token re-check
  // before its `setAcceptState`), by design — the same two reasons above apply:
  // a late `setState` is a silent no-op, and there is no double-fire to guard.
  //
  // That leaves ONE reuse race the render-phase prop-reset above does NOT cover:
  // a parent rerenders this instance with token B WHILE token A's accept IIFE is
  // still in flight. The render-phase guard sets `idle`, then A's IIFE resolves
  // and overwrites it with A's stale `resolved` data. No bespoke in-flight guard
  // is owed at any tier:
  //   • Tier 2 — the race is UNREACHABLE: no parent reuses this instance (the
  //     view is rendered standalone with a fixed `token`).
  //   • Tier 8 — the parent keys this view per invite, so a token change DISCARDS
  //     the prior instance; A's in-flight IIFE then calls `setAcceptState` on an
  //     UNMOUNTED instance — the SAME React 18/19 silent no-op cited just above
  //     for the post-unmount case. The race dissolves at root, no UI corruption.
  // So the keying that completes the post-settled reuse fix (render-phase block
  // above) also neutralizes this in-flight race — no cancellation logic needed.
  const handleAcceptClick = (): void => {
    setAcceptState({ kind: "pending" });

    // `DaemonMethod` brand cast (Plan-007 follow-up), TIGHTENED to the real
    // contract types. The bridge declares
    // `daemon.call<M extends DaemonMethod>(method: M, params: DaemonParams<M>):
    // Promise<DaemonResult<M>>` where `DaemonMethod` is a `never`-shaped brand
    // at Tier 1 — no string literal is structurally assignable to it until
    // Plan-007 narrows the brand to a string-literal union of real method names
    // (see packages/contracts/src/desktop-bridge.ts §Plan-007 daemon protocol
    // stubs). The method-name string stays loosely `string` (the genuinely
    // untypeable part until Plan-007 lands). But unlike SessionBootstrap, which
    // casts params AND return to `unknown`, we pin params → `InviteAccept` and
    // return → `Promise<InviteAcceptResponse>`. That localizes the Plan-007
    // brand bypass to ONE documented cast, keeps the params object type-checked
    // at the call site, and means the resolved value needs NO downstream
    // `as InviteAcceptResponse` cast. This is a deliberate IMPROVEMENT over
    // SessionBootstrap's loose `unknown`/`unknown`; SessionBootstrap should
    // adopt the same tightening later, but that edit is out of T6.1's scope.
    const acceptInvite = window.sidekicks.daemon.call as (
      method: string,
      params: InviteAccept,
    ) => Promise<InviteAcceptResponse>;

    // Sync-throw normalization for the Tier-1 stub-contract gap. The contract
    // `daemon.call` returns `Promise<DaemonResult<M>>`, but the Tier-1 stub
    // (`createTier1Bridge` in packages/contracts/src/desktop-bridge.ts) violates
    // that by throwing SYNCHRONOUSLY — `() => tier1Throw("invite.accept")`. A
    // bare `acceptInvite(…).then(…).catch(…)` would evaluate `acceptInvite(…)`
    // first; the sync throw would propagate OUT before `.then` is reached and
    // escape this handler entirely, leaving the view pinned in `kind: "pending"`
    // with no error rendered. Wrapping the call in an async IIFE lets `await`
    // funnel BOTH a synchronous throw AND an async rejection into the same
    // `catch` branch. This is the same defense SessionBootstrap applies on
    // mount, preserved here on the button-click path. Plan-007 may fix the stub
    // later; until then the renderer defends against the gap.
    void (async () => {
      try {
        const bridgeResponse = await acceptInvite(INVITE_ACCEPT_METHOD, { token });
        // No `as InviteAcceptResponse` cast — the tightened brand cast above
        // already types `acceptInvite`'s resolved value as `InviteAcceptResponse`.
        setAcceptState({ kind: "resolved", value: bridgeResponse });
      } catch (bridgeError: unknown) {
        // Tier-1 production branch: every Tier-1 bridge method throws
        // `NotImplementedAtTier1Error` (desktop-bridge.ts `createTier1Bridge`).
        // We do not narrow on `instanceof` — any `Error` shape renders the same
        // way; the contract is "render the error envelope," not "render a
        // specific error class." Non-`Error` rejections (string, plain object)
        // are wrapped so the render branch always holds a real `Error` instance.
        const normalizedError =
          bridgeError instanceof Error ? bridgeError : new Error(String(bridgeError));
        setAcceptState({ kind: "rejected", error: normalizedError });
      }
    })();
  };

  // Section-per-state render — the Accept button lives ONLY inside the `idle`
  // branch, so a double-fire is impossible by construction: once clicked, the
  // state transitions to `pending` and the button is no longer in the tree.
  // No `disabled` attribute and no mid-click re-entrancy guard are needed; this
  // is the clean structural mirror of SessionBootstrap's section-per-state shape.
  if (acceptState.kind === "idle") {
    return (
      <section aria-label="invite-accept-idle">
        <p>You have been invited to join a session.</p>
        <button type="button" onClick={handleAcceptClick}>
          Accept invite
        </button>
      </section>
    );
  }

  if (acceptState.kind === "pending") {
    // `aria-busy` announces the in-flight state to assistive tech.
    return (
      <section aria-label="invite-accept-pending" aria-busy="true">
        <p>Accepting invite…</p>
      </section>
    );
  }

  if (acceptState.kind === "resolved") {
    // Surface the joined-membership facts the accept path returns. A short
    // labeled list (vs. SessionBootstrap's single "session id: …" line) fits
    // the richer six-field `InviteAcceptResponse`.
    return (
      <section aria-label="invite-accept-resolved">
        <p>session id: {acceptState.value.sessionId}</p>
        <p>role: {acceptState.value.role}</p>
        <p>membership state: {acceptState.value.state}</p>
        <p>membership id: {acceptState.value.membershipId}</p>
      </section>
    );
  }

  // role="alert" so assistive tech announces the rejection.
  return (
    <section aria-label="invite-accept-error" role="alert">
      <p>
        {acceptState.error.name}: {acceptState.error.message}
      </p>
    </section>
  );
}
