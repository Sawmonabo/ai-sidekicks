// What the attach flow SENDS and what it settles to — the wire half of T5.2.
//
// Split out of `AttachFlow.tsx` on the seam the component itself has: one side
// composes a registered mutation, issues it, and turns whatever comes back into a
// settled view state; the other side decides when to ask and what to draw. Everything
// here is total over its arguments and touches no React, so the cases that matter —
// the prop winning over a stale draft key, the Tier-1 synchronous throw, a typed
// refusal envelope, a rejection that is not an object — are one call each rather than
// a mounted component and a stubbed bridge.
//
// THE SETTLE IS TOTAL, and the component relies on that: `settleAttachRequest`
// returns a settled `AttachViewState` on every path and rejects on none, so the
// caller needs no second failure route and no unhandled rejection is reachable.

import type {
  RuntimeNodeAttachRequest,
  RuntimeNodeAttachResponse,
  SessionId,
} from "@ai-sidekicks/contracts";

import { wireRejectionToError } from "../../../shared/wire-errors.js";

// `RUNTIME_NODE_ATTACH_PROCEDURE` — the REGISTERED runtime-node attach
// mutation: registry row `docs/architecture/contracts/api-payload-contracts.md §Runtime-Node Method-Name Registry (Tier 3)` (`mutation`, request
// `RuntimeNodeAttachRequest`, response `RuntimeNodeAttachResponse`; the
// five-method registry table at :560-566). Hardcoded as a local `const` per
// the shipped renderer idiom (NodeRoster's `ROSTER_READ_PROCEDURE`,
// participant-roster's `PRESENCE_READ_METHOD`): the bridge surface is
// generic, so the registered name is the single greppable coupling point the
// Plan-023 Tier 8 IPC wiring binds. The name lives in the `runtimenode.*`
// METHOD namespace (error.ts:106-109 — deliberately separator-free, distinct
// from the `runtime_node.*` EVENT names). Unlike the control-plane-only
// roster query, `runtimenode.attach` is dual-transport — see the TRANSPORT
// note in the header for why this view rides the control-plane arm.
const RUNTIME_NODE_ATTACH_PROCEDURE = "runtimenode.attach";

/**
 * The node's attach self-description:
 * `packages/contracts/src/runtime-node.ts#RuntimeNodeAttachRequest`
 * MINUS the target `sessionId` — i.e. the
 * `Spec-003 §Required Behavior` payload components (node identity, declared
 * capabilities, health, trust context) without the session the view targets.
 *
 * Derived via `Omit` rather than re-declared so it tracks the shipped wire
 * contract BY CONSTRUCTION: `{ ...attachDraft, sessionId }` in the click
 * handler reconstitutes a complete, cast-free `RuntimeNodeAttachRequest`
 * (draft spread FIRST, explicit `sessionId` LAST — see the spread-order note
 * in the handler for why that ordering is load-bearing), and
 * a future contract field lands in this type (and therefore in the request
 * this view sends) automatically instead of silently falling out of sync —
 * the drift-safety reason one grouped draft prop wins over flat per-field
 * props.
 */
export type RuntimeNodeAttachDraft = Omit<RuntimeNodeAttachRequest, "sessionId">;

// Discriminated-union view state — the SessionBootstrap three-state register
// (`pending | resolved | rejected`, SessionBootstrap.tsx:37-40 — the
// action-flow register the T5.2 task row pins, vs the `loading|loaded|error`
// READ-view register of the two rosters) plus the `idle` initial state every
// click-triggered view needs (invite-accept-view.tsx:111-115). Each variant
// maps 1:1 to a rendered `<section>` branch below, so the render is a total
// function over the union. The `resolved` variant carries the verbatim
// shipped `RuntimeNodeAttachResponse` DTO
// (`packages/contracts/src/runtime-node.ts#RuntimeNodeAttachResponse`) — no
// local view-model.
export type AttachViewState =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "resolved"; response: RuntimeNodeAttachResponse }
  | { kind: "rejected"; error: Error };

/**
 * Issue the attach mutation for this target and settle it into a view state.
 *
 * `async` rather than a bare call chain for the reason the sync-throw note below
 * gives: `await` inside this function funnels the Tier-1 SYNCHRONOUS throw and a
 * future asynchronous rejection into the same `catch`, so both reach the caller as a
 * `rejected` state rather than as an escaping error with the view pinned `pending`.
 */
export async function settleAttachRequest(
  sessionId: SessionId,
  attachDraft: RuntimeNodeAttachDraft,
): Promise<AttachViewState> {
  // `CpProcedure` brand cast (Plan-002/Plan-008 follow-up), tightened to
  // the real types — the same single-documented-cast posture as the sibling
  // `NodeRoster.tsx#readRoster` cast and T6.1's
  // `acceptInvite`. The bridge declares `controlPlane.call<P extends
  // CpProcedure>(procedure: P, input: CpInput<P>): Promise<CpOutput<P>>`
  // (desktop-bridge.ts:277) where `CpProcedure` is a `never`-shaped brand
  // at Tier 1 (desktop-bridge.ts:99) — no string literal is structurally
  // assignable to it until the control-plane tRPC surface narrows the
  // brand. The procedure-name string stays loosely `string` (the genuinely
  // untypeable part), but we PIN input →
  // `packages/contracts/src/runtime-node.ts#RuntimeNodeAttachRequest` (the
  // spread-built request object below is type-checked at the call site) and
  // return → `Promise<RuntimeNodeAttachResponse>` (declared in the same
  // contracts module — the resolved value needs no downstream cast).
  const attachRuntimeNode = window.sidekicks.controlPlane.call as (
    procedure: string,
    input: RuntimeNodeAttachRequest,
  ) => Promise<RuntimeNodeAttachResponse>;

  // Sync-throw normalization for the Tier-1 stub-contract gap — the T5.2
  // task row pins this defense to the SessionBootstrap precedent
  // (SessionBootstrap.tsx:69-101). The contract `controlPlane.call` returns
  // a Promise, but the Tier-1 stub throws SYNCHRONOUSLY
  // (`() => tier1Throw("controlPlane.call")`, desktop-bridge.ts:353). A
  // bare `attachRuntimeNode(...).then(...).catch(...)` would evaluate the
  // call first; the sync throw would escape this handler before `.then` is
  // reached — an uncaught error with the view pinned `pending`. The async
  // IIFE lets `await` funnel the sync throw AND a future async rejection
  // into the same `catch`, so the Tier-1 `NotImplementedAtTier1Error` lands
  // in the rejected branch RENDERED — never an unhandled rejection, never a
  // crash.
  try {
    // `{ ...attachDraft, sessionId }` reconstitutes the complete
    // `RuntimeNodeAttachRequest` — the node's self-description plus the
    // target session this view was handed. No cast: the draft type is
    // contract-derived, so the object checks against the pinned input
    // type above. SPREAD ORDER IS LOAD-BEARING — the explicit `sessionId`
    // key comes LAST so the prop ALWAYS wins: `Omit` is type-level only,
    // so a caller can pass a full `RuntimeNodeAttachRequest` as the draft
    // (width subtyping; a pre-typed variable bypasses excess-property
    // checking), and under a draft-LAST spread that stray runtime
    // `sessionId` key would silently re-target the wire call away from
    // the rendered "target session" line — defeating the header's
    // `Spec-003 §Required Behavior` target-session guarantee on a trust-bearing action. Do NOT "tidy" this into
    // `{ sessionId, ...attachDraft }`.
    const attachmentResponse = await attachRuntimeNode(RUNTIME_NODE_ATTACH_PROCEDURE, {
      ...attachDraft,
      sessionId,
    });
    return { kind: "resolved", response: attachmentResponse };
  } catch (bridgeError: unknown) {
    // Tier-3 production branch at the Tier-1 bridge — see
    // `wireRejectionToError` (shared, `src/shared/wire-errors.ts`) does
    // the envelope handling: a typed refusal —
    // `runtimenode.attach_conflict`, the single-active-attachment
    // (Plan-003 §Invariants I-003-5) refusal, or
    // `runtimenode.attach_revoked` — is rebuilt with the wire `code` as
    // `Error.name`, so this branch renders WHICH refusal occurred rather
    // than a generic class name. The BARE (non-`total`) wrap is correct
    // here: this is a bridge CATCH binding, so the rejection came off the
    // IPC surface where a ToPrimitive-failing shape is not reachable.
    // DELIBERATELY no below-floor (`version.floor_exceeded`) recognizer,
    // in contrast to NodeRoster's: a below-floor daemon is ADMITTED at
    // attach — read-only, never refused (`Spec-003 §Required Behavior`;
    // I-003-1 admit-not-eject) — so `VERSION_FLOOR_EXCEEDED` is a verdict
    // on SUBSEQUENT version-sensitive writes, never on this call.
    return { kind: "rejected", error: wireRejectionToError(bridgeError) };
  }
}
