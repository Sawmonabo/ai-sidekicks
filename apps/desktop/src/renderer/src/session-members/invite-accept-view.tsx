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
// CRITERION-GATED DEFERRAL — this view's renderer-held-`token` + explicit-Accept
// shape is a DELIBERATE Tier-2 interim posture that DEVIATES from the Spec-023
// §Deep-Link Invite Flow target contract. It is NOT yet the settled end-state;
// reconciliation is gated on Plan-023 Tier 8 (criterion (c) below). A reviewer
// should read this view as the interim posture, not as a finished realization of
// §Deep-Link.
//
//   (a) Tier-2 posture (as-built — what ships now). The renderer receives the
//       opaque `token` as a prop and issues the daemon-as-gateway
//       `daemon.call("invite.accept", { token })`; an explicit Accept button
//       gives user confirmation. The Accept button is a DELIBERATE,
//       USER-INITIATED trigger, not a mount side-effect — auto-accepting on
//       mount would silently consume a single-use invite on route-load (the
//       wrong UX). This is the deliberate divergence from `SessionBootstrap`,
//       whose mount-trigger fits "create a session as the app loads" but would
//       be wrong for "accept an invite as a route renders"; it is also why this
//       view has an `idle` state that `SessionBootstrap` lacks (a
//       mount-triggered component starts `pending`; a button-triggered one
//       starts `idle`, the pre-click prompt). The posture is chosen for
//       independent renderability + testability: this is a self-contained
//       component with a clear prop contract, and the T6.3 component tests
//       render it with a mock `token` + a mock `window.sidekicks` bridge. No
//       router / deep-link handler exists yet to supply the `token` prop in
//       production — and that is expected here, not a gap to flag against T6.1.
//   (b) Spec-023 §Deep-Link target shape. There, the MAIN process extracts the
//       token from `sidekicks://invite/<token>`, calls `acceptInvite(token)`
//       itself (PASETO + DPoP), and emits a renderer bridge event carrying the
//       new membership; the renderer NAVIGATES to the joined session and has no
//       Accept button — "the raw invite token never crosses the bridge to the
//       renderer" (§Deep-Link final step). The Tier-2 posture deviates on TWO
//       axes: token confinement (renderer holds the raw `token` vs
//       main-process-only) and acceptance trigger (renderer-initiated Accept
//       button vs main-process auto-accept on URL fire). Reconciling MAY reshape
//       this view into a bridge-event-driven "joined" confirmation, possibly
//       with no renderer-initiated Accept — OR, if the explicit-confirmation UX
//       in (a) is judged the better product design, MAY instead warrant a
//       Spec-023 §Deep-Link amendment. This deferral does NOT pre-decide which.
//   (c) Pay-off trigger. Plan-023 Tier 8 ships the `sidekicks://invite/<token>`
//       deep-link protocol handler + the invite-acceptance bridge event contract
//       (the SAME Tier-8 gate as T6.4's two-client smoke). Neither exists today;
//       the full §Deep-Link flow cannot be built until they land.
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
