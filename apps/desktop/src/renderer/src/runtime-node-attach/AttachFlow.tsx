// Plan-003 Phase 5 T5.2 (Tier 3) — renderer AttachFlow component.
//
// The Spec-003 AC1 surface (line 127): a USER-INITIATED flow that attaches a
// local runtime node to an ALREADY-ACTIVE session — the live session whose
// branded id arrives as the `sessionId` prop — through the Spec-023 preload
// bridge. The view renders the node's full attach declaration up front, fires
// the registered `runtimenode.attach` mutation on an explicit click, and
// renders the resolved attachment verdict (or the rejection envelope)
// verbatim.
//
// Spec-003 coverage:
//   • §AC1 (line 127, "a participant can attach a local runtime node to an
//     already active session"): the idle branch presents the attach prompt
//     for the live target session; the click handler issues the attach call;
//     the resolved branch renders the attachment the call returns.
//   • Line 50 ("runtime-node attach must not require session recreation") —
//     held STRUCTURALLY: the component receives an EXISTING `SessionId` and
//     its only wire call is `runtimenode.attach`. No `session.create` (or any
//     other session-minting call) exists in this file, so attach cannot
//     recreate the session by construction; the rendered "target session"
//     line shows the attach is INTO the session the view was handed.
//   • Line 48 ("attach must include node identity, declared capabilities,
//     health, and trust context"): the declaration block enumerates all four
//     payload components — `nodeId` (identity), the `capabilities` map
//     rendered by the composed `CapabilityDeclaration` (declared
//     capabilities), `healthState` (the daemon's 2-value self-reported health
//     axis, runtime-node.ts:108), and `participantId` + `clientVersion`
//     (trust context: the membership identity the attach rides and the
//     version the control plane compares against the session floor, Spec-003
//     line 53) — and the request carries exactly those fields plus the
//     target `sessionId` (`RuntimeNodeAttachRequest`, runtime-node.ts:124-131).
//   • Line 47 ("runtime-node attach must be a separate step from membership
//     acceptance"): the I-003-3 block below — the separation is this view's
//     invariant.
//
// I-003-3 (attach is separate from membership) — the invariant this task
// verifies (Plan-003 §Invariants, the I-003-3 entry at lines 49-55:
// "`RuntimeNodeAttach` MUST NOT modify session_memberships"; the T5.2 row
// pins the renderer reading — attach and membership surface as DISTINCT
// actions, never coupled to a `session_memberships` mutation). Concretely:
//   • The ONLY wire call in this file is the `runtimenode.attach` mutation —
//     no `membership.*`, no `invite.*`, no `session.*` call, named or
//     implied. Membership acceptance is a SEPARATE, PRIOR step owned by a
//     DIFFERENT view (`session-members/invite-accept-view.tsx`, the Plan-002
//     T6.1 surface): a participant first holds active membership (Spec-003
//     line 46), THEN — as its own deliberate action — attaches a node under
//     it.
//   • A future editor will be tempted to fold the two into a "one-click
//     accept-invite-and-attach" convenience inside this flow's handler. That
//     is the exact inversion I-003-3 exists to forbid: accepting an invite
//     would auto-attach a runtime node (the Spec-002 §Pitfalls security
//     violation the invariant's why-load-bearing clause names), and
//     membership would become automatic node trust (Spec-003 §Pitfalls line
//     121). Keep this view's wire surface at exactly one procedure.
//
// CLICK-TRIGGERED, NOT MOUNT-TRIGGERED — why this view has an `idle` state:
//
//   The attach fires from an explicit button, never as a mount side effect,
//   so the state machine starts at `idle` (the pre-click prompt) — the same
//   deliberate divergence from mount-triggered `SessionBootstrap` the shipped
//   click-flow precedent documents (invite-accept-view.tsx:35-36, "a
//   mount-triggered component starts `pending`, a button-triggered one starts
//   `idle`"). Auto-attach-on-mount would be wrong twice over:
//     • Attach must read as a deliberate, user-initiated action of its OWN —
//       an attach that fires because something rendered couples the
//       trust-bearing step to navigation (the same wrong-UX shape T6.1
//       rejected for invite acceptance, where mount-fire would consume the
//       invite on route-load).
//     • The user must see what the node declares BEFORE it attaches
//       (Spec-003 line 48 + the line-58 least-privilege default): the idle
//       branch renders the full declaration — identity, capabilities, health,
//       trust context — ahead of any wire call.
//   The async lifecycle that follows the click is exactly the
//   SessionBootstrap three-state register (`pending | resolved | rejected`,
//   SessionBootstrap.tsx:37-40), as the T5.2 task row pins.
//
// TRANSPORT — the GENERIC `controlPlane.call(...)` bridge arm:
//
//   `runtimenode.attach` is registered DUAL-transport
//   (api-payload-contracts.md:552 — the four mutations register under the
//   Plan-007-partial daemon JSON-RPC substrate AND cross the Plan-008
//   control-plane tRPC transport). This renderer rides the CONTROL-PLANE arm because:
//     • the attach lands control-plane-owned cross-node coordination state —
//       the `runtime_node_attachments` row (Spec-003 line 52: "the control
//       plane must coordinate runtime-node discovery and presence");
//     • the shipped end-to-end proof of the procedure is the control-plane
//       SDK arm (`createControlPlaneRuntimeNodeClient` in
//       packages/client-sdk/src/runtimeNodeClient.ts, Plan-003 Phase 4) — the
//       surface the Plan-023 Tier 8 IPC wiring binds the bridge onto;
//     • the in-directory sibling (NodeRoster's roster read) already routes
//       through `controlPlane.call(...)`, keeping the whole
//       runtime-node-attach subtree on ONE bridge surface.
//   At Tier 1 every bridge method throws `NotImplementedAtTier1Error`
//   (desktop-bridge.ts:334-336 `tier1Throw`; the `controlPlane.call` stub at
//   :353), so the REJECTED branch is the production-observable path until
//   Plan-023 Tier 8 wires the real IPC handler. The remaining gap is the
//   bridge WIRING, not the contract.
//
// Renderer-untrusted boundary (Spec-023 §Trust Stance) — this file imports ONLY:
//   • `react` — the renderer's UI engine; explicitly allowed.
//   • Type-only from `@ai-sidekicks/contracts` — the contracts package is
//     renderer-safe (no `node:*`, `electron`, or `fs`/`path`/`process` runtime
//     imports); the type-only form emits NO JS runtime import, so only the
//     type-graph view of the wire shapes reaches the renderer.
//   • The sibling `./CapabilityDeclaration.js` — renderer-internal
//     composition within this subtree (itself presentational and
//     bridge-free).
// No `electron`, no `node:*`, no `./src/main/**`, no `./src/preload/**`, and no
// `@ai-sidekicks/client-sdk` (the Node-side `runtimeNodeClient.ts` SDK) —
// statically enforced via the `no-restricted-imports` rule in
// apps/desktop/eslint.config.mjs. (The `@ai-sidekicks/client-sdk` ban is
// by-convention at Tier 1; lint will not catch it until a renderer-targeted
// entry lands at the Plan-023 Tier 8 hoist, per the SessionBootstrap header.)

import { useState } from "react";

import type {
  RuntimeNodeAttachRequest,
  RuntimeNodeAttachResponse,
  SessionId,
} from "@ai-sidekicks/contracts";

import { CapabilityDeclaration } from "./CapabilityDeclaration.js";

// The `window.sidekicks` ambient type lives in the renderer-wide
// `sidekicks-bridge.d.ts` (Plan-002 Phase 6 T6.0; part of the renderer
// typecheck graph via its `include`), so `window.sidekicks` below is
// `SidekicksBridge`-typed without an import here. The bridge exposes exactly
// six GENERIC capability surfaces (Spec-023; desktop-bridge.ts:265-314) —
// there is no `runtimeNode` namespace and no per-procedure typing yet, so the
// registered `runtimenode.attach` name rides the generic
// `controlPlane.call(...)` surface below.

// Wire procedure name.
//
// `RUNTIME_NODE_ATTACH_PROCEDURE` — the REGISTERED runtime-node attach
// mutation: registry row api-payload-contracts.md:558 (`mutation`, request
// `RuntimeNodeAttachRequest`, response `RuntimeNodeAttachResponse`; the
// five-method registry table at :556-562). Hardcoded as a local `const` per
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
 * The node's attach self-description: `RuntimeNodeAttachRequest`
 * (runtime-node.ts:124-131) MINUS the target `sessionId` — i.e. the Spec-003
 * line-48 payload components (node identity, declared capabilities, health,
 * trust context) without the session the view targets.
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

/**
 * Props for {@link AttachFlow}.
 *
 * `sessionId` is the branded {@link SessionId} of the ALREADY-ACTIVE session
 * to attach into (Spec-003 line 127 "already active"; line 50 — the id is
 * received, never minted, so attach cannot recreate a session). It arrives as
 * a prop (supplied by a future Plan-023 router/deep-link; exercised by the
 * T5.4 manual smoke), the same prop-contract posture as `NodeRoster` /
 * `ParticipantRoster`.
 *
 * `attachDraft` is the node's self-description (see
 * {@link RuntimeNodeAttachDraft}). At Tier 3 it arrives as a prop for the
 * same reason `sessionId` does: the renderer is untrusted and cannot discover
 * the local node's identity/capabilities itself (Spec-023 §Trust Stance) —
 * the future Plan-023 wiring assembles the draft main-process-side (off the
 * daemon's node registry) and hands it to this view for the user's pre-attach
 * review.
 */
export interface AttachFlowProps {
  sessionId: SessionId;
  attachDraft: RuntimeNodeAttachDraft;
}

// Discriminated-union view state — the SessionBootstrap three-state register
// (`pending | resolved | rejected`, SessionBootstrap.tsx:37-40 — the
// action-flow register the T5.2 task row pins, vs the `loading|loaded|error`
// READ-view register of the two rosters) plus the `idle` initial state every
// click-triggered view needs (invite-accept-view.tsx:111-115). Each variant
// maps 1:1 to a rendered `<section>` branch below, so the render is a total
// function over the union. The `resolved` variant carries the verbatim
// shipped `RuntimeNodeAttachResponse` DTO (runtime-node.ts:169-174) — no
// local view-model.
type AttachViewState =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "resolved"; response: RuntimeNodeAttachResponse }
  | { kind: "rejected"; error: Error };

/**
 * Renders the runtime-node attach flow for an already-live session: the
 * pre-attach declaration + Attach prompt (idle), an in-flight indicator
 * (pending), the resolved attachment facts (resolved), or the rejection
 * envelope with a retry path (rejected).
 *
 * State primitive — manual `useState` discriminated union (NOT React 19
 * `useTransition`/`useActionState`), matching the shipped
 * `InviteAcceptView`/`SessionBootstrap`/`NodeRoster` precedent: it keeps the
 * renderer consumers structurally consistent and fits the Tier-1 sync-throw
 * normalization, which needs an explicit `try/catch` around the bridge call.
 */
export function AttachFlow({ sessionId, attachDraft }: AttachFlowProps): React.JSX.Element {
  const [attachViewState, setAttachViewState] = useState<AttachViewState>({ kind: "idle" });

  // Attachment-identity prop reset (React's "Adjusting some state when a prop
  // changes" pattern — the same render-phase mechanism every shipped sibling
  // uses). The flow's identity is the (sessionId, nodeId) PAIR — exactly the
  // attachment-row identity (`UNIQUE(node_id, session_id)`,
  // runtime-node.ts:634-636) — so when EITHER changes (a future Plan-023
  // router reusing this mounted instance for another session or another node)
  // the settled state resets to `idle`: the prior target's
  // `resolved`/`rejected` branch must not survive under a new target.
  // Deliberately NOT a comparison of the whole `attachDraft` object: object
  // props are referentially unstable across parent re-renders, so a
  // whole-draft check would spuriously reset settled state on every
  // re-render; the two branded strings compare stably. The complete fix for
  // instance reuse is the Tier-8 parent keying this view per attachment
  // target; this render-phase reset is the narrower fallback until that
  // keying lands, and the in-flight-IIFE race it does not cover is harmless
  // for the same two reasons T6.1 documents (a late `setState` is a silent
  // no-op; Tier-8 keying discards the instance —
  // invite-accept-view.tsx:185-197).
  const [previousAttachmentTarget, setPreviousAttachmentTarget] = useState({
    sessionId,
    nodeId: attachDraft.nodeId,
  });
  if (
    sessionId !== previousAttachmentTarget.sessionId ||
    attachDraft.nodeId !== previousAttachmentTarget.nodeId
  ) {
    setPreviousAttachmentTarget({ sessionId, nodeId: attachDraft.nodeId });
    setAttachViewState({ kind: "idle" });
  }

  // Sync click handler (React's `onClick` contract); the async attach work
  // runs in a void IIFE inside it — the same shape the shipped click-flow
  // precedent uses (invite-accept-view.tsx `handleAcceptClick`).
  //
  // No post-unmount `setState` guard (no `cancelled` flag) — the documented
  // T6.1 posture for click paths (invite-accept-view.tsx:169-183), NOT an
  // omission: React 18/19 made `setState` on an unmounted component a silent
  // no-op, and `onClick` handlers are not Strict-Mode double-invoked, so the
  // mount-effect race that forces `NodeRoster`/`ParticipantRoster` to carry a
  // `cancelled` flag does not arise here. A future reader must not
  // "harmonize" a guard INTO this handler to match the effect-driven siblings
  // — the difference (mount-effect race vs click no-op) is load-bearing in
  // both directions.
  const handleAttachClick = (): void => {
    setAttachViewState({ kind: "pending" });

    // `CpProcedure` brand cast (Plan-002/Plan-008 follow-up), tightened to
    // the real types — the same single-documented-cast posture as the sibling
    // NodeRoster's `readRoster` (NodeRoster.tsx:386-389) and T6.1's
    // `acceptInvite`. The bridge declares `controlPlane.call<P extends
    // CpProcedure>(procedure: P, input: CpInput<P>): Promise<CpOutput<P>>`
    // (desktop-bridge.ts:277) where `CpProcedure` is a `never`-shaped brand
    // at Tier 1 (desktop-bridge.ts:99) — no string literal is structurally
    // assignable to it until the control-plane tRPC surface narrows the
    // brand. The procedure-name string stays loosely `string` (the genuinely
    // untypeable part), but we PIN input → `RuntimeNodeAttachRequest`
    // (runtime-node.ts:124-131 — the spread-built request object below is
    // type-checked at the call site) and return →
    // `Promise<RuntimeNodeAttachResponse>` (runtime-node.ts:169-174 — the
    // resolved value needs no downstream cast).
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
    void (async () => {
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
        // the rendered "target session" line — defeating the header's line-50
        // guarantee on a trust-bearing action. Do NOT "tidy" this into
        // `{ sessionId, ...attachDraft }`.
        const attachmentResponse = await attachRuntimeNode(RUNTIME_NODE_ATTACH_PROCEDURE, {
          ...attachDraft,
          sessionId,
        });
        setAttachViewState({ kind: "resolved", response: attachmentResponse });
      } catch (bridgeError: unknown) {
        // Tier-3 production branch at the Tier-1 bridge — see
        // `normalizeAttachError` below for the envelope handling.
        setAttachViewState({ kind: "rejected", error: normalizeAttachError(bridgeError) });
      }
    })();
  };

  // The node's attach declaration, rendered on EVERY branch — the four
  // Spec-003 line-48 payload components are the node's standing
  // self-description, relevant before (idle), during (pending), and after
  // (resolved/rejected) the call. The "target session" line makes the
  // no-recreation posture visible: the attach is INTO this existing live
  // session (Spec-003 line 50).
  const nodeDeclaration = (
    <>
      <ul aria-label="attach-node-declaration">
        <li>target session: {sessionId}</li>
        <li>node id: {attachDraft.nodeId}</li>
        <li>participant id: {attachDraft.participantId}</li>
        <li>client version: {attachDraft.clientVersion}</li>
        <li>reported health: {attachDraft.healthState}</li>
      </ul>
      <CapabilityDeclaration capabilities={attachDraft.capabilities} />
    </>
  );

  if (attachViewState.kind === "idle") {
    // Pre-attach review + the explicit trigger. The Attach button lives ONLY
    // here and in the rejected branch (retry) — never in `pending` — so a
    // double-fire is impossible BY CONSTRUCTION: once clicked, the state
    // transitions to `pending` and the button leaves the tree (the same
    // structural guard as invite-accept-view.tsx:254-258; no `disabled`
    // attribute, no re-entrancy flag). `data-attach-state` carries the flow
    // state on every branch for the T5.4 manual smoke.
    return (
      <section aria-label="runtime-node-attach-idle" data-attach-state="idle">
        {nodeDeclaration}
        <button type="button" onClick={handleAttachClick}>
          Attach runtime node
        </button>
      </section>
    );
  }

  if (attachViewState.kind === "pending") {
    // `aria-busy` announces the in-flight call to assistive tech; no button
    // in this branch (the structural double-fire guard above).
    return (
      <section
        aria-label="runtime-node-attach-pending"
        aria-busy="true"
        data-attach-state="pending"
      >
        {nodeDeclaration}
        <p>Attaching runtime node…</p>
      </section>
    );
  }

  if (attachViewState.kind === "resolved") {
    // Resolved — the attachment verdict rendered VERBATIM off the shipped
    // `RuntimeNodeAttachResponse` DTO (runtime-node.ts:169-174), no local
    // view-model:
    //   • `state` is the server-derived `NodeState` AS RETURNED — a fresh
    //     attachment is typically `registering`, NOT `online` (Spec-003 line
    //     57: nodes default online only after the daemon-side capability
    //     declaration succeeds; I-003-2). Attach-success MUST NOT be
    //     presented as node-healthy, so no "online"/"healthy" copy is
    //     synthesized here.
    //   • `readOnly` is the attach-time floor verdict (Spec-003 line 53: a
    //     below-floor daemon is ADMITTED read-only, not refused), labeled
    //     with the same at-floor/below-floor wording as the sibling
    //     NodeRoster row (NodeRoster.tsx:550-552) so the two surfaces read
    //     consistently. The full below-floor UX (typed VERSION_FLOOR_EXCEEDED
    //     on a later write) is T5.3's MixedVersionStatus scope, not this
    //     view's.
    // `data-node-state` / `data-read-only` mirror NodeRoster's facet
    // attributes so the T5.4 manual smoke asserts both views with one
    // selector vocabulary.
    return (
      <section
        aria-label="runtime-node-attach-resolved"
        data-attach-state="resolved"
        data-node-state={attachViewState.response.state}
        data-read-only={attachViewState.response.readOnly}
      >
        {nodeDeclaration}
        <ul>
          <li>attachment id: {attachViewState.response.attachmentId}</li>
          <li>state: {attachViewState.response.state}</li>
          <li>
            access:{" "}
            {attachViewState.response.readOnly ? "read-only (below version floor)" : "read-write"}
          </li>
          <li>attached at: {attachViewState.response.attachedAt}</li>
        </ul>
      </section>
    );
  }

  // Rejected — role="alert" so assistive tech announces the failure; the
  // envelope renders `name: message` (the Tier-1 `NotImplementedAtTier1Error`
  // is the production-observable case; a typed wire envelope renders its wire
  // `code` as the name — see `normalizeAttachError`). Unlike T6.1's TERMINAL
  // rejected branch (retrying a single-use invite token is not safely
  // re-armable), attach is retryable: the server treats a re-attach as the
  // single-active-attachment upsert (Plan-003 §Invariants I-003-5), so the
  // retry button re-arms the same handler rather than dead-ending the flow
  // behind a full remount.
  return (
    <section aria-label="runtime-node-attach-error" role="alert" data-attach-state="rejected">
      {nodeDeclaration}
      <p>
        {attachViewState.error.name}: {attachViewState.error.message}
      </p>
      <button type="button" onClick={handleAttachClick}>
        Retry attach
      </button>
    </section>
  );
}

// Wire error envelope — the code+message-only refusal shape the
// `runtimenode.*` typed refusals carry (error.ts:103-110: "code+message-only
// (no Details/Schema) per the registry-only 409 convention"), e.g.
// `runtimenode.attach_conflict` — the single-active-attachment (Plan-003
// §Invariants I-003-5) refusal — or `runtimenode.attach_revoked`
// (error.ts:111-114). The recognizer is SHAPE-generic (any string `code` +
// string `message`), deliberately NOT bound to specific code literals: this
// branch's job is to render WHICH typed refusal occurred (`code: message`),
// not to branch behavior per code — no acceptance criterion of this view
// distinguishes refusal causes (that starts at T5.3, where the below-floor
// write refusal gets dedicated surfacing). The check is structural, not
// identity-based, so it matches a plain wire object and an `Error` subclass
// carrying the code (the SDK's `RuntimeNodeControlPlaneError` shape) alike —
// the same shape-not-identity stance as NodeRoster's recognizer.
function isWireErrorEnvelope(value: unknown): value is { code: string; message: string } {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { code?: unknown; message?: unknown };
  return typeof candidate.code === "string" && typeof candidate.message === "string";
}

// Normalizes an attach rejection into a render-ready `Error` (hoisted out of
// the handler per the NodeRoster `normalizeRosterReadError` precedent):
//   • A typed wire envelope (or an `Error` carrying a wire `code`) is rebuilt
//     as a fresh `Error` with the wire `code` as `Error.name`, so the
//     rendered envelope reads `runtimenode.attach_conflict: …` rather than a
//     generic class name — or `[object Object]` for a plain-object rejection.
//     Checked FIRST so an SDK-style Error-with-code renders its code (the
//     same ordering as NodeRoster's normalization).
//   • Any other `Error` passes through unchanged — the Tier-1
//     `NotImplementedAtTier1Error` (which carries no `code` property, so it
//     never matches the envelope check) is the production-observable case
//     today.
//   • Anything else is wrapped via `String(...)` so the render branch always
//     holds a real `Error` instance.
// DELIBERATELY NO below-floor (`version.floor_exceeded`) recognizer here, in
// contrast to NodeRoster's: a below-floor daemon is ADMITTED at attach —
// read-only, never refused (Spec-003 line 53; I-003-1 admit-not-eject) — so
// `VERSION_FLOOR_EXCEEDED` is a verdict on SUBSEQUENT version-sensitive
// writes, never on this call. The below-floor outcome on THIS path is the
// RESOLVED branch's `readOnly: true`, rendered verbatim; labeling a floor
// code on an attach rejection would dignify a contract-violating response as
// an expected state.
function normalizeAttachError(rejection: unknown): Error {
  if (isWireErrorEnvelope(rejection)) {
    const envelopeError = new Error(rejection.message);
    envelopeError.name = rejection.code;
    return envelopeError;
  }
  return rejection instanceof Error ? rejection : new Error(String(rejection));
}
