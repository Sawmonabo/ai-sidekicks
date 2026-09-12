// A per-node mixed-version access indicator.
//
// It distinguishes "read-only (below floor)" from "full read/write (at floor)"
// from "detached", and surfaces the typed `VERSION_FLOOR_EXCEEDED` outcome of a
// version-sensitive write attempt while the node stays visible and joined. It is
// PURELY PRESENTATIONAL over ALREADY-RESOLVED state (the CapabilityDeclaration
// posture — no bridge access, no hooks): the floor verdict is computed by the
// control-plane service and arrives on the `RuntimeNodeRosterEntry` wire DTO
// (`readOnly`, derived per row at read time — that field on
// `RuntimeNodeRosterEntrySchema`; server derivation in
// `packages/control-plane/src/runtime-nodes/attach-service.ts#readRoster`).
// This view consumes it and NEVER re-derives floor logic — no
// `clientVersion`-vs-floor comparison exists in this file, by design.
//
// What that buys, concretely: the access-status verdict renders the
// admitted-read-only state off the server-resolved `readOnly` axis; the
// write-refusal block surfaces the typed `version.floor_exceeded` envelope
// verbatim (code + message) when a write attempt returned it; and the
// node-status block renders on EVERY refusal arm — the refusal annotates the
// node, it never replaces or hides it. The control plane is what verifies the
// daemon's reported version against the session's `min_client_version` floor;
// its OUTPUT is the `readOnly` flag this view projects, and the typed refusal
// this view surfaces is the verdict on a subsequent version-sensitive domain
// write (e.g. a capability declaration via `capabilityupdate`).
//
// ADMIT, NEVER EJECT. A below-floor daemon MUST be admitted in a read-only
// state — it remains joined and may read session state — and ejection is never
// the response to a floor mismatch. The renderer reading: below-floor nodes
// present as joined-but-read-only, never as ejected. Concretely, three tripwires
// for future editors:
//   • The access verdict NEVER reads the write-refusal prop. A
//     `version.floor_exceeded` refusal must not flip the rendered status —
//     the server-resolved `readOnly` axis is the SINGLE floor source
//     (`resolveAccessStatus` below takes only the roster entry). Inferring
//     "below floor" from a refusal envelope would be renderer-side floor
//     re-derivation, which this view does not do.
//   • The node-status block renders on EVERY write-refusal arm. Do NOT
//     restructure the render so a refusal replaces the status (an
//     eject-by-render) — "the node stays visible and joined" is held by this
//     structure.
//   • A below-floor (`readOnly: true`) entry renders PRESENT and labeled. Do
//     NOT add a branch that hides, nulls out, or maps a below-floor or
//     refused node to the detached verdict — below-floor is a JOINED state.
//
// "DETACHED" — what the shipped contract can actually represent. `NodeState`
// has NO `detached` member (the 5-value enum `registering | online | degraded
// | offline | revoked` — `packages/contracts/src/runtime-node.ts#NodeState`),
// and detachment is NOT row deletion either. The two contract-representable
// manifestations:
//   • An explicitly detached node's attachment row PERSISTS with the terminal
//     slot state `offline`: the guarded retire UPDATE in
//     `packages/control-plane/src/runtime-nodes/attach-service.ts#detach`
//     moves the single active row to `offline` ("detach writes the TERMINAL
//     state `offline` ONLY" — the scope note in that method's JSDoc) —
//     slot-axis `offline` is server-effected via
//     explicit detach, never daemon-self-reported, since the sweep owns only
//     the PRESENCE axis — and the roster read is a faithful projection that
//     returns every row with no server-side hiding. So a detached node
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
// detached/disconnected node MAY reconnect under the same node identity, while
// `revoked` is an authority-issued trust denial that detach itself refuses to
// overwrite (the revocation-terminality guard in `AttachService.detach`) and
// that refuses re-attach terminally. Rendering a revoked node as "detached"
// would mask a trust decision as a clean disconnect and invite a doomed
// re-attach — the same masking that is forbidden between the health axes. The
// three-way distinction (read-only / read-write / detached) stays satisfied:
// those three remain pairwise distinguishable, and the fourth token is what
// totality over the shipped 5-value enum honestly requires.
//
// SUPPLIED-BY-PARENT posture (the precedent set by the `attachDraft` prop on
// `AttachFlow.tsx#AttachFlowProps`): this view performs no wire call. The roster
// entry is read upstream through the GENERIC bridge surface — the registered
// control-plane-only `runtimenode.roster` query
// (`window.sidekicks.controlPlane.call(...)`, exactly the sibling NodeRoster's
// read) — by the parent, which selects the local node's entry and hands it down.
// The write-attempt outcome likewise arrives as a prop: no live
// version-sensitive write path exists in the renderer, so the parent that issues
// the write (e.g. the registered `runtimenode.capabilityupdate` mutation)
// catches the rejection and hands it to this indicator for surfacing. ALL state
// this view renders is therefore bridge-sourced; none is renderer-discovered,
// and none is re-derived here.
//
// The renderer is untrusted, so this file imports ONLY type-only from
// `@ai-sidekicks/contracts` (the contracts package is renderer-safe; the
// type-only form emits NO JS runtime import, so only the type-graph view of the
// wire shapes reaches the renderer). It needs no
// `react` value import: there are no hooks (purely presentational), and JSX
// compiles via the automatic runtime (`jsx: "react-jsx"` in the renderer
// tsconfig), which injects its own `react/jsx-runtime` import at build time —
// the CapabilityDeclaration precedent. No `electron`, no `node:*`, no
// `./src/main/**`, no `./src/preload/**`, and no `@ai-sidekicks/client-sdk`
// (the Node-side `runtimeNodeClient.ts` SDK) — statically enforced via the
// `no-restricted-imports` rule in apps/desktop/eslint.config.mjs (the
// `@ai-sidekicks/client-sdk` ban is structural since the package left this
// app's manifest, per the SessionBootstrap header).

import type { RuntimeNodeRosterEntry, VersionFloorExceededCode } from "@ai-sidekicks/contracts";

import { ACCESS_STATUS_LABELS, resolveAccessStatus } from "./node-access-status.js";

// Wire-rejection recognition and normalization live once, in `src/shared/`, for
// every renderer surface and both Electron processes.
// This file used to carry four local copies — a floor recognizer, a generic
// envelope guard, a total stringifier, and a normalizer — each under a comment
// naming the duplication and defending it on file scope. File scope is a
// reason to hoist, not a reason to copy: what actually differs between this
// view and its siblings is ONE boundary fact (this rejection arrives as a
// PROP, theirs as bridge `catch` bindings), and that difference is now the
// `total` option rather than a third normalizer.
import {
  readWireErrorEnvelopeWithCode,
  wireRejectionToError,
} from "../../../shared/wire-errors.js";

// `VERSION_FLOOR_EXCEEDED_WIRE_CODE` — the canonical wire code for the
// below-floor refusal, single-sourced in contracts as
// `NEGOTIATION_REASON_FLOOR_EXCEEDED` (the plain `as const` literal at
// jsonrpc-negotiation.ts:211) and aliased as the `VersionFloorExceededCode`
// type (error.ts:96-98). This is the tree's ONLY below-floor discriminant:
// the sibling roster view stopped branching on the code when its normalizer
// moved to `src/shared/wire-errors.ts` (the shared normalizer renders every
// typed envelope by its own code, so a code-specific recognizer bought that
// view nothing), leaving this indicator — which genuinely branches, because
// the floor verdict gets its own render arm here — as the single home.
// The literal is drift-safe BY THE TYPE BINDING, not by discipline:
// annotating it with the imported `VersionFloorExceededCode` binds it to the
// contracts literal at compile time, so if the canonical code ever drifts this
// line becomes a type error rather than the branch silently ceasing to match
// (which would demote a below-floor refusal to the generic arm and lose the
// typed surfacing unflagged — the reader's `===` is a runtime comparison
// nothing else checks). The binding costs nothing at runtime: `import type` plus a
// type-annotated local literal emit no JS import, so the file stays type-only
// from `@ai-sidekicks/contracts`. (The wire VALUE itself is already hoisted in
// contracts; per the repo's hoist test, a compile-bound local literal is the
// correct consumption shape for a renderer that imports types only.)
const VERSION_FLOOR_EXCEEDED_WIRE_CODE: VersionFloorExceededCode = "version.floor_exceeded";

/**
 * Props for {@link MixedVersionStatus}.
 *
 * `rosterEntry` is the node's row from the registered `runtimenode.roster`
 * read (`packages/contracts/src/runtime-node.ts#RuntimeNodeRosterEntry` — the
 * shipped wire DTO, carrying the server-resolved `state` + `readOnly`
 * axes this indicator projects), or `null` when the session roster carries NO
 * row for the node — the parent's lookup miss, e.g.
 * `rosterResponse.nodes.find((node) => node.nodeId === localNodeId) ?? null`.
 * REQUIRED with an explicit `null`, deliberately not optional: under
 * `exactOptionalPropertyTypes` an omittable prop would let a parent silently
 * forget the binding, and absence-of-prop is not the same fact as
 * stated-absence-of-attachment — the detached verdict must be passed, not
 * defaulted into. Supplied by the parent, the same posture as
 * `AttachFlow.attachDraft`.
 *
 * `writeAttemptRejection` is the caught outcome of the most recent
 * version-sensitive domain write the parent routed through this node (e.g.
 * the registered `runtimenode.capabilityupdate` mutation), or `null` when no
 * refused write has been observed.
 * Typed `unknown`, NOT a narrowed envelope type, because that is what the
 * parent actually holds — a `catch` binding — and because RECOGNITION
 * AUTHORITY lives in this indicator (the `VERSION_FLOOR_EXCEEDED_WIRE_CODE`
 * branch below): the parent needs no wire-code knowledge and cannot mislabel
 * a generic failure as a floor verdict. A non-floor rejection passed here is
 * surfaced generically and explicitly NOT labeled below-floor (see the
 * unrecognized arm) — parents should route ordinary write failures to their
 * own flow's error surface (the AttachFlow rejected-branch pattern).
 */
export interface MixedVersionStatusProps {
  rosterEntry: RuntimeNodeRosterEntry | null;
  writeAttemptRejection: unknown;
}

/**
 * Renders a runtime node's mixed-version access status — the three-way
 * distinction (read-only below floor / read-write at floor / detached, plus
 * the honest `revoked` fourth) — and surfaces the typed
 * `VERSION_FLOOR_EXCEEDED` outcome of a refused version-sensitive write,
 * alongside (never instead of) the node status: the node stays visible and
 * joined through a refusal.
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
  // The floor refusal as a SNAPSHOT, never a narrowing of the prop: this rejection
  // is `unknown` and whatever a parent caught, so a member read at the render below
  // would be a second access on an unvalidated value — one that answers differently
  // paints an arm the wire never sent, and one that throws unmounts the node this
  // component exists to keep visible, which is eject-by-render.
  const floorRefusal = readWireErrorEnvelopeWithCode(
    writeAttemptRejection,
    VERSION_FLOOR_EXCEEDED_WIRE_CODE,
  );

  // The write-refusal block — one of three arms, computed ahead of the single
  // return so the render below states the admit-not-eject structure plainly:
  // the node-status block renders on EVERY arm, with this block ALONGSIDE it
  // (tripwire #2 in the header — a refusal annotates the node, it never
  // replaces it).
  let writeRefusalBlock: React.JSX.Element;
  if (writeAttemptRejection === null || writeAttemptRejection === undefined) {
    // Explicit empty state (the CapabilityDeclaration empty-map register —
    // its `data-capability-count={0}` branch keeps the empty state
    // machine-assertable): a not-yet-refused write is a meaningful fact kept
    // machine-assertable ahead of the refusal leg, never silent blankness.
    // `null` is the documented "none" value; `undefined` is tolerated as the
    // same fact (the prop is `unknown`, so a parent's optional-chain miss can
    // arrive here).
    writeRefusalBlock = <p data-write-refusal="none">no refused write attempt to surface</p>;
  } else if (floorRefusal !== undefined) {
    // The typed `version.floor_exceeded` envelope rendered verbatim (wire code
    // + server message), with the admit-not-eject fact stated in copy — the
    // refused WRITE is the only thing denied; the node remains joined and
    // readable. The `data-write-refusal` facet carries the canonical wire
    // literal itself (the type-annotated const, so the selector token is
    // compile-time-bound to contracts — no invented vocabulary for a reader to
    // learn). `role="alert"` announces the refusal to assistive tech (the
    // sibling error-branch posture). Do NOT add a detach/remove affordance to
    // this arm (tripwire #3 in the header): a floor refusal is a degradation
    // verdict, not an exit path.
    writeRefusalBlock = (
      <div
        role="alert"
        aria-label="version-floor-write-refusal"
        data-write-refusal={VERSION_FLOOR_EXCEEDED_WIRE_CODE}
      >
        <p>
          write refused: {floorRefusal.code}: {floorRefusal.message}
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
    // no-floor-recognizer stance on its attach path.
    //
    // `total: true` is the ONE way this call differs from the siblings', and
    // the difference is a boundary fact rather than a preference. Their
    // rejections are bridge CATCH bindings — values that arrived through the
    // IPC/promise-rejection surface, where a ToPrimitive-failing shape is not
    // realistically reachable. This one is a PROP, and a prop admits arbitrary
    // `unknown`, so the wrap must be TOTAL: a pathological value degrades to a
    // lossy string and the refusal-surfacing component never crashes on the
    // very value it exists to surface. A render throw would unmount the tree —
    // no error boundary exists in the renderer — and even a future boundary
    // would only swap the crash for a fallback that hides the node: an
    // eject-by-render, which this view exists to prevent.
    const normalizedRejection = wireRejectionToError(writeAttemptRejection, { total: true });
    writeRefusalBlock = (
      <div role="alert" aria-label="unrecognized-write-rejection" data-write-refusal="unrecognized">
        <p>
          write rejection (not a version-floor refusal) — {normalizedRejection.name}:{" "}
          {normalizedRejection.message}
        </p>
      </div>
    );
  }

  // One root section, constant aria-label, facets as data attributes — the
  // selector vocabulary shared with the sibling views:
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
        // exists to make the read-only verdict auditable and
        // roster-displayable — the `clientVersion` field on
        // `RuntimeNodeRosterEntrySchema`). Displayed as CONTEXT only; the
        // verdict itself is the server-resolved `readOnly` (no comparison
        // happens here — file-header posture).
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
