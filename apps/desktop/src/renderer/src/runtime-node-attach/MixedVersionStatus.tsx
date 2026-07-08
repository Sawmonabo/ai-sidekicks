// Plan-003 Phase 5 T5.3 (Tier 3) — renderer MixedVersionStatus component.
//
// The `Spec-003 §Acceptance Criteria` AC4 surface: a PER-NODE mixed-version status
// indicator that distinguishes "read-only (below floor)" from "full
// read/write (at floor)" from "detached", and surfaces the typed
// `VERSION_FLOOR_EXCEEDED` outcome of a version-sensitive write attempt while
// the node stays visible and joined. It is PURELY PRESENTATIONAL over
// ALREADY-RESOLVED state (the CapabilityDeclaration posture — no bridge
// access, no hooks): the floor verdict is computed by the Phase-3
// control-plane service and arrives on the `RuntimeNodeRosterEntry` wire DTO
// (`readOnly`, derived per row at read time — runtime-node.ts:604-609; server
// derivation in `AttachService.readRoster`, attach-service.ts:1000-1059);
// this view consumes it and NEVER re-derives floor logic — no
// `clientVersion`-vs-floor comparison exists in this file, by design (the
// T5.3 task row, `Plan-003 §T5.3 — Mixed-version status indicator (below-floor read-only surfacing)`).
//
// Spec-003 coverage:
//   • `Spec-003 §Acceptance Criteria` AC4 ("admitted in read-only state, surfaces typed
//     `VERSION_FLOOR_EXCEEDED` on any subsequent version-sensitive domain
//     write (e.g. a capability declaration via `capabilityupdate`), and is
//     never ejected for the floor mismatch"): the access-status verdict
//     renders the admitted-read-only state off the server-resolved
//     `readOnly` axis; the write-refusal block surfaces the typed
//     `version.floor_exceeded` envelope verbatim (code + message) when a
//     write attempt returned it; and the node-status block renders on EVERY
//     refusal arm — the refusal annotates the node, it never replaces or
//     hides it (the never-ejected clause, structurally).
//   • Line 53 ("the control plane MUST verify the daemon's reported version
//     against the session's `min_client_version` floor … admitted in
//     read-only state"): consumed, not derived — the verification's OUTPUT is
//     the `readOnly` flag this view projects, and the typed refusal it
//     surfaces is the line-53 verdict on a subsequent version-sensitive
//     domain write (e.g. a capability declaration via `capabilityupdate`).
//
// I-003-1 (admit-not-eject) — the invariant this task verifies
// (`Plan-003 §I-003-1 — Attach is admit-not-eject for below-floor daemons`:
// a below-floor daemon "MUST be admitted in
// read-only state — the daemon remains joined and may read session state";
// "Ejection MUST NOT be the response to a floor mismatch"). The renderer
// reading (the T5.3 task row): below-floor nodes present as
// joined-but-read-only, never as ejected. Concretely, three tripwires for
// future editors:
//   • The access verdict NEVER reads the write-refusal prop. A
//     `version.floor_exceeded` refusal must not flip the rendered status —
//     the server-resolved `readOnly` axis is the SINGLE floor source
//     (`resolveAccessStatus` below takes only the roster entry). Inferring
//     "below floor" from a refusal envelope would be renderer-side floor
//     re-derivation, exactly what the task row forbids.
//   • The node-status block renders on EVERY write-refusal arm. Do NOT
//     restructure the render so a refusal replaces the status (an
//     eject-by-render) — the AC's "while the node stays visible/joined"
//     clause is held by this structure.
//   • A below-floor (`readOnly: true`) entry renders PRESENT and labeled. Do
//     NOT add a branch that hides, nulls out, or maps a below-floor or
//     refused node to the detached verdict — below-floor is a JOINED state.
//
// "DETACHED" — what the shipped contract can actually represent. `NodeState`
// has NO `detached` member (the 5-value enum `registering | online | degraded
// | offline | revoked`, runtime-node.ts:86), and detachment is NOT row
// deletion either. The two contract-representable manifestations:
//   • An explicitly detached node's attachment row PERSISTS with the terminal
//     slot state `offline`: `AttachService.detach` UPDATEs the single active
//     row to `offline` (attach-service.ts:640-647; "detach writes the
//     TERMINAL state `offline` ONLY", :581) — slot-axis `offline` is
//     server-effected via explicit detach, never daemon-self-reported
//     (`Spec-003 §Default Behavior`; the sweep owns only the PRESENCE axis) —
//     and the roster read is a faithful projection that returns every row
//     with no server-side hiding (`Spec-003 §Interfaces And Contracts`). So a detached node
//     arrives HERE as an entry with `state: "offline"`.
//   • A node NEVER attached to the session has no `runtime_node_attachments`
//     row at all — the roster carries no entry, so absence needs an explicit
//     prop-level representation: the `rosterEntry: RuntimeNodeRosterEntry |
//     null` prop, where the parent passes its roster-lookup miss as `null`.
// Both manifestations resolve to the `detached` verdict; the underlying
// distinction stays machine-visible on the `data-node-state` facet (present
// as `"offline"` for the retired row, ABSENT for the missing row — the same
// absent-attribute-mirrors-absence posture as NodeRoster's null
// `healthState`).
//
// `revoked` is DELIBERATELY a fourth, distinct verdict — never collapsed into
// `detached`. The contract keeps the two terminal states apart on purpose: a
// detached/disconnected node MAY reconnect under the same node identity
// (`Spec-003 §Fallback Behavior`), while `revoked` is an authority-issued trust denial
// (`Spec-003 §Default Behavior`) that detach itself refuses to overwrite (the
// revocation-terminality guard, attach-service.ts:634-636) and that refuses
// re-attach terminally. Rendering a revoked node as "detached" would mask a
// trust decision as a clean disconnect and invite a doomed re-attach — the
// same masking the Spec-003 line-72 never-mask stance forbids between health
// axes. The AC's three-way distinction (read-only / read-write / detached)
// stays satisfied — those three remain pairwise distinguishable; the fourth
// token is what totality over the shipped 5-value enum honestly requires.
//
// SUPPLIED-BY-PARENT posture (the AttachFlow `attachDraft` precedent,
// AttachFlow.tsx:178-189): at Tier 3 this view performs no wire call. The
// roster entry is read upstream through the GENERIC bridge surface — the
// registered control-plane-only `runtimenode.roster` query
// (`window.sidekicks.controlPlane.call(...)`, exactly the sibling NodeRoster's
// read; `Spec-003 §Interfaces And Contracts` amendment) — by the
// future Plan-023 Tier-8 parent (exercised by the T5.4 manual smoke), which
// selects the local node's entry and hands it down. The write-attempt outcome
// likewise arrives as a prop: no live version-sensitive write path exists at
// Tier 3, so the parent that issues the write (e.g. the registered
// `runtimenode.capabilityupdate` mutation) catches the rejection and hands it
// to this indicator for surfacing. ALL state this view renders is therefore
// bridge-sourced; none is renderer-discovered, and none is re-derived here.
//
// Renderer-untrusted boundary (Spec-023 §Trust Stance) — this file imports
// ONLY type-only from `@ai-sidekicks/contracts` (the contracts package is
// renderer-safe; the type-only form emits NO JS runtime import, so only the
// type-graph view of the wire shapes reaches the renderer). It needs no
// `react` value import: there are no hooks (purely presentational), and JSX
// compiles via the automatic runtime (`jsx: "react-jsx"` in the renderer
// tsconfig), which injects its own `react/jsx-runtime` import at build time —
// the CapabilityDeclaration precedent. No `electron`, no `node:*`, no
// `./src/main/**`, no `./src/preload/**`, and no `@ai-sidekicks/client-sdk`
// (the Node-side `runtimeNodeClient.ts` SDK) — statically enforced via the
// `no-restricted-imports` rule in apps/desktop/eslint.config.mjs (the
// `@ai-sidekicks/client-sdk` ban is by-convention at Tier 1, per the
// SessionBootstrap header).

import type {
  RuntimeNodeRosterEntry,
  VersionFloorExceededCode,
  VersionFloorExceededError,
} from "@ai-sidekicks/contracts";

// `VERSION_FLOOR_EXCEEDED_WIRE_CODE` — the canonical wire code for the
// below-floor refusal (ADR-018 §Decision #10), single-sourced in contracts as
// `NEGOTIATION_REASON_FLOOR_EXCEEDED` (the plain `as const` literal at
// jsonrpc-negotiation.ts:211) and aliased as the `VersionFloorExceededCode`
// type (error.ts:96-98). LOCAL DUPLICATE of the sibling NodeRoster's const
// (NodeRoster.tsx:221) — NodeRoster deliberately does not export its
// recognizer machinery, and this task's file scope cannot widen the sibling.
// The duplication is drift-safe BY THE TYPE BINDING, not by discipline:
// annotating each local literal with the imported `VersionFloorExceededCode`
// binds BOTH copies to the contracts literal at compile time, so if the
// canonical code ever drifts, both files become type errors rather than
// either recognizer silently ceasing to match (which would demote a
// below-floor refusal to the generic envelope and lose the AC4 typed
// surfacing unflagged — a type predicate's body is an unchecked assertion).
// The binding costs nothing at runtime: `import type` plus a type-annotated
// local literal emit no JS import, so the file stays type-only from
// `@ai-sidekicks/contracts`. (The wire VALUE itself is already hoisted in
// contracts; per the repo's hoist test, a compile-bound local literal is the
// correct consumption shape for a renderer that imports types only.)
const VERSION_FLOOR_EXCEEDED_WIRE_CODE: VersionFloorExceededCode = "version.floor_exceeded";

/**
 * Props for {@link MixedVersionStatus}.
 *
 * `rosterEntry` is the node's row from the registered `runtimenode.roster`
 * read (`RuntimeNodeRosterEntry`, runtime-node.ts:560-570 — the shipped T5.0b
 * wire DTO, carrying the server-resolved `state` + `readOnly` axes this
 * indicator projects), or `null` when the session roster carries NO row for
 * the node — the parent's lookup miss, e.g.
 * `rosterResponse.nodes.find((node) => node.nodeId === localNodeId) ?? null`.
 * REQUIRED with an explicit `null`, deliberately not optional: under
 * `exactOptionalPropertyTypes` an omittable prop would let a parent silently
 * forget the binding, and absence-of-prop is not the same fact as
 * stated-absence-of-attachment — the detached verdict must be passed, not
 * defaulted into. Supplied by the future Plan-023 Tier-8 parent (exercised by
 * the T5.4 manual smoke), the same posture as `AttachFlow.attachDraft`.
 *
 * `writeAttemptRejection` is the caught outcome of the most recent
 * version-sensitive domain write the parent routed through this node (e.g.
 * the registered `runtimenode.capabilityupdate` mutation — the Spec-003
 * line-53 example), or `null` when no refused write has been observed.
 * Typed `unknown`, NOT a narrowed envelope type, because that is what the
 * parent actually holds — a `catch` binding — and because RECOGNITION
 * AUTHORITY lives in this indicator (`isVersionFloorExceededRejection`
 * below): the parent needs no wire-code knowledge and cannot mislabel a
 * generic failure as a floor verdict. A non-floor rejection passed here is
 * surfaced generically and explicitly NOT labeled below-floor (see the
 * unrecognized arm) — parents should route ordinary write failures to their
 * own flow's error surface (the AttachFlow rejected-branch pattern).
 */
export interface MixedVersionStatusProps {
  rosterEntry: RuntimeNodeRosterEntry | null;
  writeAttemptRejection: unknown;
}

// The four-token access verdict — the AC4 three-way distinction (read-only /
// read-write / detached) plus the honest `revoked` fourth (see the header's
// revoked-vs-detached note). These are the machine tokens the
// `data-access-status` facet carries for the T5.4 manual smoke (and future
// BL-131 automated coverage).
type NodeAccessStatus = "read-write" | "read-only" | "detached" | "revoked";

// Human labels per verdict. The two ATTACHED labels are byte-identical to the
// sibling access wording (NodeRoster.tsx:550-552; AttachFlow.tsx:411) so the
// three runtime-node views read consistently in the T5.4 smoke; the two
// RETIRED labels state the load-bearing difference between the terminal
// states (reconnect-allowed vs re-attach-refused — `Spec-003 §Fallback Behavior` and `Spec-003 §Default Behavior`).
const ACCESS_STATUS_LABELS: Record<NodeAccessStatus, string> = {
  "read-write": "read-write",
  "read-only": "read-only (below version floor)",
  detached: "detached (no active attachment)",
  revoked: "revoked (authority-issued; re-attach is refused)",
};

// Resolves the access verdict from the server-resolved roster facets. This is
// render-time LABELING of already-resolved state — the reconciliation
// `Spec-003 §Default Behavior` / `Spec-003 §Interfaces And Contracts` explicitly assign to the client — NOT floor
// derivation: no version comparison occurs here or anywhere in this file (the
// floor verdict is consumed verbatim as `readOnly`, computed by
// `AttachService.readRoster` — see the file header). Deliberately a function
// of the roster entry ALONE: the write-refusal prop must never influence the
// verdict (I-003-1 tripwire #1 in the header — a refusal envelope is not a
// second floor source).
//   • `null` (no roster row — never attached) and slot `state: "offline"`
//     (explicitly detached; the row persists per the header's grounding) both
//     resolve to `detached`.
//   • `state: "revoked"` resolves to its own verdict, never `detached` (the
//     header's masking argument).
//   • The three GROUPED case labels — `registering | online | degraded` — are
//     exactly the ACTIVE attachment set (I-003-5, Plan-003 §Invariants line
//     67: "offline and revoked are inactive"; the `idx_node_attachments_active`
//     partial-index predicate), so the verdict is the PERMISSION axis
//     verbatim: `readOnly` distinguishes below-floor from at-floor. Liveness
//     and slot-health rendering stay the sibling NodeRoster's mandate — this
//     indicator surfaces the ACCESS axis, and the raw `state` stays
//     machine-visible on the `data-node-state` facet, so nothing is masked by
//     the focus.
//   • The `default` arm is a COMPILE-TIME EXHAUSTIVENESS BINDING (see its
//     inline note): without it, a fall-through would silently misclassify a
//     future sixth `NodeState` member as ACTIVE.
function resolveAccessStatus(rosterEntry: RuntimeNodeRosterEntry | null): NodeAccessStatus {
  if (rosterEntry === null) return "detached";
  switch (rosterEntry.state) {
    case "offline":
      return "detached";
    case "revoked":
      return "revoked";
    case "registering":
    case "online":
    case "degraded":
      return rosterEntry.readOnly ? "read-only" : "read-write";
    default: {
      // The load-bearing arm — the same documented-pin-becomes-enforced-pin
      // move as the type-annotated wire-code const above. `NodeState`
      // additions are reserved as MINOR by the contract (runtime-node.ts:73-77;
      // ADR-018 §Decision #8 — "removals MAJOR, additions MINOR"), so
      // a sixth member is EXPECTED evolution, and an unbound fall-through
      // would silently hand it the active-set projection above (an ACTIVE
      // verdict for a state whose activity nobody classified). The `never`
      // annotation turns any addition into a type error ON THIS LINE instead,
      // forcing a human to classify the new state's verdict at the recompile.
      // In the version-skew window BEFORE that recompile (additions are
      // MINOR, so a newer server can hand the state to this older renderer),
      // the raw token flows through verbatim: the `data-access-status` facet
      // carries it (degraded but honest — the facet is the machine contract;
      // the prose label line degrades to blank for that window) and nothing
      // throws — a render crash would hide the node entirely, the
      // eject-by-render this file's I-003-1 tripwires forbid.
      const unhandledNodeState: never = rosterEntry.state;
      return unhandledNodeState;
    }
  }
}

// Below-floor rejection envelope — the load-bearing consumption of the
// `VersionFloorExceededError` contract (contract_consumes). LOCAL DUPLICATE
// of the sibling original (NodeRoster.tsx:278), same drift-safety argument as
// the wire-code const above. `Pick` keeps the recognizer HONEST about what
// the write-refusal surface actually delivers: the full
// `VersionFloorExceededError` (error.ts:332-336) requires
// `details: VersionBoundExceededDetails` — the TWO-sided HTTP `ErrorResponse`
// shape — but the runtime-node refusal surface is code+message-only (the
// one-sided session floor cannot populate `acceptedRange`; the SDK's
// `RuntimeNodeControlPlaneError` rejection shape (runtimeNodeClient.ts:320-332)
// likewise carries no `details` — only `code` + `message`, plus a
// transport-level `httpStatus`). Narrowing to the full interface while
// checking two fields would let a future reader dereference `.details` with
// the type system's blessing and crash on the real envelope; the `Pick`
// makes that unrepresentable while still typing both discriminants off the
// shipped contract.
type VersionFloorRejectionEnvelope = Pick<VersionFloorExceededError, "code" | "message">;

// Below-floor recognizer — LOCAL DUPLICATE of the sibling original
// (NodeRoster.tsx:302-308; that file does not export it, and it sits outside
// this task's file scope). The wire code `version.floor_exceeded` is the
// typed verdict a below-floor node's version-sensitive write returns
// (`VERSION_FLOOR_EXCEEDED`, ADR-018 §Decision #4 / I-003-1) — exactly the
// contract the `readOnly: true` axis PROJECTS, so recognizing it here is what
// lets the AC4 write-refusal block label the typed outcome distinctly rather
// than as a generic failure. The guard is STRUCTURAL (shape, not identity):
// it matches a plain wire envelope and an `Error` subclass carrying the code
// (the SDK's `RuntimeNodeControlPlaneError`) alike. Discharging the `code`
// discriminant by `===` equality is SOUND because `VersionFloorExceededCode`
// is a plain single-sourced string-literal type, NOT a nominal brand, and the
// compared literal is the type-annotated const above — compile-time-bound to
// the contracts literal rather than free-floating.
function isVersionFloorExceededRejection(value: unknown): value is VersionFloorRejectionEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { code?: unknown; message?: unknown };
  return (
    candidate.code === VERSION_FLOOR_EXCEEDED_WIRE_CODE && typeof candidate.message === "string"
  );
}

// Generic wire error envelope — the code+message-only refusal shape the
// `runtimenode.*` typed refusals carry (error.ts:103-110), e.g.
// `runtimenode.capabilityupdate_conflict` — a realistic non-floor arrival on
// this very prop (a write racing a detach raises it, error.ts:117-124). LOCAL
// DUPLICATE of the sibling original (AttachFlow.tsx:455-459), shape-generic
// by design (any string `code` + string `message`, no literals to drift):
// this arm's job is to render WHICH refusal occurred, not to branch behavior
// per code. Checked AFTER the floor recognizer (the specific-before-generic
// ordering both siblings' normalizations use).
function isWireErrorEnvelope(value: unknown): value is { code: string; message: string } {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { code?: unknown; message?: unknown };
  return typeof candidate.code === "string" && typeof candidate.message === "string";
}

// Never-throwing lossy fallback for values bare `String(...)` cannot render —
// LOCAL DUPLICATE of the sibling original (CapabilityDeclaration.tsx:70-85;
// that file does not export it, and it sits outside this task's file scope).
// Bare `String(...)` is NOT total: it runs ToPrimitive, which itself throws
// for a null-prototype object — or null-prototype FUNCTION — carrying no
// `toString`/`valueOf`/`Symbol.toPrimitive` (and a hostile throwing
// `toString` propagates the same way), so it gets an inner guard. The
// terminal fallback is a string LITERAL, deliberately not
// `Object.prototype.toString.call(...)`: even that can throw (its
// `Symbol.toStringTag` lookup is a Get, and a hostile getter propagates), so
// only a literal makes the totality claim PROVABLE rather than merely one
// pathological layer deeper.
//
// BOUNDARY CLASS — why this file guards where the two normalizations it
// otherwise mirrors keep the bare wrap (AttachFlow.tsx:489;
// NodeRoster.tsx:595): their rejection inputs are bridge-CATCH bindings —
// values that arrived through the IPC/promise-rejection surface, where a
// ToPrimitive-failing shape is not realistically reachable. This file's
// rejection input is a PROP (`writeAttemptRejection`), and the prop boundary
// admits arbitrary `unknown` at Tier 3 — exactly the rationale the
// CapabilityDeclaration original states for its capability values — so the
// wrap must be TOTAL: a pathological prop value degrades to a lossy string,
// and the refusal-surfacing component never crashes on the very value it
// exists to surface (a render throw would unmount the tree — no error
// boundary exists in the renderer at Tier 3 — and even a future boundary
// would only swap the crash for a fallback that hides the node: an
// eject-by-render). Do NOT "harmonize" the siblings' bare wrap into this
// file, or this guard into them — the boundary difference is load-bearing in
// both directions.
function lossyStringify(rejection: unknown): string {
  try {
    return String(rejection);
  } catch {
    return "[unrepresentable value]";
  }
}

// Normalizes a NON-floor write rejection into a render-ready `Error` for the
// unrecognized arm (the floor envelope never reaches this — it gets the
// dedicated AC4 block instead). Same register as the siblings'
// normalizations (AttachFlow.tsx:483-490; NodeRoster.tsx:589-596), with ONE
// deliberate divergence in the terminal arm (see `lossyStringify` above):
//   • A typed wire envelope (or an `Error` carrying a wire `code`) is rebuilt
//     as a fresh `Error` with the wire `code` as `Error.name`, so the render
//     reads `runtimenode.capabilityupdate_conflict: …` rather than a generic
//     class name — or `[object Object]` for a plain-object rejection.
//   • Any other `Error` passes through unchanged.
//   • Anything else is wrapped through the never-throwing `lossyStringify`
//     into a fresh `Error` — the wrap itself cannot throw on a pathological
//     prop value (ToPrimitive failure), so the render-ready guarantee is
//     total, not best-effort.
function normalizeUnrecognizedRejection(rejection: unknown): Error {
  if (isWireErrorEnvelope(rejection)) {
    const envelopeError = new Error(rejection.message);
    envelopeError.name = rejection.code;
    return envelopeError;
  }
  return rejection instanceof Error ? rejection : new Error(lossyStringify(rejection));
}

/**
 * Renders a runtime node's mixed-version access status — the AC4 three-way
 * distinction (read-only below floor / read-write at floor / detached, plus
 * the honest `revoked` fourth) — and surfaces the typed
 * `VERSION_FLOOR_EXCEEDED` outcome of a refused version-sensitive write,
 * alongside (never instead of) the node status: the node stays visible and
 * joined through a refusal (I-003-1 admit-not-eject).
 *
 * Purely presentational: no bridge access, no hooks — the roster entry and
 * the write-attempt outcome arrive as props (see {@link
 * MixedVersionStatusProps} and the file header for the supplied-by-parent
 * posture). The verdict is resolved from server-computed state only; this
 * view derives no floor logic.
 */
export function MixedVersionStatus({
  rosterEntry,
  writeAttemptRejection,
}: MixedVersionStatusProps): React.JSX.Element {
  const accessStatus = resolveAccessStatus(rosterEntry);

  // The write-refusal block — one of three arms, computed ahead of the single
  // return so the render below states the I-003-1 structure plainly: the
  // node-status block renders on EVERY arm, with this block ALONGSIDE it
  // (tripwire #2 in the header — a refusal annotates the node, it never
  // replaces it).
  let writeRefusalBlock: React.JSX.Element;
  if (writeAttemptRejection === null || writeAttemptRejection === undefined) {
    // Explicit empty state (the CapabilityDeclaration empty-map register,
    // CapabilityDeclaration.tsx:131-132 — "keeps the empty state
    // machine-assertable for the T5.4 manual smoke"): a not-yet-refused write
    // is a meaningful fact kept machine-assertable for the smoke ahead of the
    // refusal leg, never silent blankness. `null` is the documented "none"
    // value; `undefined` is tolerated as the same fact (the prop is
    // `unknown`, so a parent's optional-chain miss can arrive here).
    writeRefusalBlock = <p data-write-refusal="none">no refused write attempt to surface</p>;
  } else if (isVersionFloorExceededRejection(writeAttemptRejection)) {
    // The AC4 surfacing: the typed `version.floor_exceeded` envelope rendered
    // verbatim (wire code + server message), with the admit-not-eject fact
    // stated in copy — the refused WRITE is the only thing denied; the node
    // remains joined and readable (I-003-1). The `data-write-refusal` facet
    // carries the canonical wire literal itself (the type-annotated const, so
    // the selector token is compile-time-bound to contracts — no invented
    // vocabulary for the smoke to learn). `role="alert"` announces the
    // refusal to assistive tech (the sibling error-branch posture). Do NOT
    // add a detach/remove affordance to this arm (tripwire #3 in the header):
    // a floor refusal is a degradation verdict, not an exit path.
    writeRefusalBlock = (
      <div
        role="alert"
        aria-label="version-floor-write-refusal"
        data-write-refusal={VERSION_FLOOR_EXCEEDED_WIRE_CODE}
      >
        <p>
          write refused: {writeAttemptRejection.code}: {writeAttemptRejection.message}
        </p>
        <p>the node remains joined and readable — admitted read-only, not ejected</p>
      </div>
    );
  } else {
    // Unrecognized (non-floor) rejection — surfaced generically rather than
    // silently dropped (a swallowed prop would mask a real failure behind a
    // "none" render), and deliberately NOT labeled below-floor: dressing an
    // arbitrary failure in floor wording would fabricate a floor verdict this
    // view is forbidden to derive — the converse of AttachFlow's
    // no-floor-recognizer stance on its attach path (AttachFlow.tsx:475-482).
    const normalizedRejection = normalizeUnrecognizedRejection(writeAttemptRejection);
    writeRefusalBlock = (
      <div role="alert" aria-label="unrecognized-write-rejection" data-write-refusal="unrecognized">
        <p>
          write rejection (not a version-floor refusal) — {normalizedRejection.name}:{" "}
          {normalizedRejection.message}
        </p>
      </div>
    );
  }

  // One root section, constant aria-label, facets as data attributes (the
  // sibling selector vocabulary the T5.4 smoke asserts across views):
  //   • `data-access-status` — the four-token verdict (this view's own axis).
  //   • `data-node-state` / `data-read-only` — the underlying wire facets
  //     VERBATIM, same attribute names as NodeRoster's rows and AttachFlow's
  //     resolved branch. Both are ABSENT exactly when `rosterEntry` is null
  //     (React omits undefined-valued attributes) — the DOM mirrors row
  //     absence verbatim rather than inventing placeholder tokens, the same
  //     posture as NodeRoster's null `healthState`. Rendering the raw facets
  //     alongside the verdict keeps the labeling un-masking: every input to
  //     `resolveAccessStatus` stays independently assertable.
  return (
    <section
      aria-label="mixed-version-status"
      data-access-status={accessStatus}
      data-node-state={rosterEntry?.state}
      data-read-only={rosterEntry?.readOnly}
    >
      {rosterEntry === null ? (
        // Stated absence (the detached manifestation with no row to render):
        // an explicit line, not blank space — the parent passed `null`
        // deliberately (see the props contract).
        <p>node: no roster entry (not attached to this session)</p>
      ) : (
        // The mixed-version context: identity plus the version the node
        // declared at attach — the stored `client_version` the floor verdict
        // was computed FROM, surfaced verbatim for audit/display (the column
        // exists to make the read-only verdict "auditable +
        // roster-displayable", runtime-node.ts:613-617). Displayed as
        // CONTEXT only; the verdict itself is the server-resolved `readOnly`
        // (no comparison happens here — file-header posture).
        <ul aria-label="mixed-version-node-facts">
          <li>node id: {rosterEntry.nodeId}</li>
          <li>declared client version: {rosterEntry.clientVersion}</li>
        </ul>
      )}
      <p>access: {ACCESS_STATUS_LABELS[accessStatus]}</p>
      {writeRefusalBlock}
    </section>
  );
}
