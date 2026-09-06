// Plan-003 Phase 5 T5.1 (Tier 3) — renderer NodeRoster component.
//
// A thin projection over the read seam `node-roster-reads.ts` beside this file
// declares: it renders the SET of runtime nodes attached to the active session — one
// `RuntimeNodeRosterEntry` per `runtime_node_attachments` row, exactly as the
// registered `runtimenode.roster` read returns it (`docs/architecture/contracts/api-payload-contracts.md §Tier 3: Plan-003 — Runtime Node Attach (Task 4.4)`;
// `packages/contracts/src/runtime-node.ts#RuntimeNodeRosterEntry`) — and visually
// distinguishes the three status facets the wire entry carries:
//   • `state: NodeState` — the SLOT axis (registering|online|degraded|offline|
//     revoked — `packages/contracts/src/runtime-node.ts#NodeState`),
//     `runtime_node_attachments.state` carried
//     verbatim with all five values: the read is a faithful projection with no
//     server-side hiding (`Spec-003 §Interfaces And Contracts` amendment).
//     AC2 distinguishability (`Spec-003 §Acceptance Criteria`): a `degraded`/
//     `offline` node renders with a degraded/offline indicator, NOT a
//     disappearance — a healthy `online` node is visually distinct from one
//     that is not.
//   • `healthState` + `lastHeartbeatAt` — the LIVENESS axis: the sweep-owned
//     3-value presence verdict (`online | degraded | offline`) carried
//     VERBATIM from `runtime_node_presence`, nullable until the node's first
//     heartbeat lands (LEFT JOIN — the `healthState` field on `RuntimeNodeRosterEntrySchema`). The read NEVER
//     derives staleness (the Plan-003 T3.6 sweep stays the single
//     liveness-derivation writer), and neither does this view.
//   • `readOnly: boolean` — the PERMISSION axis, DERIVED per row at read time:
//     true iff the node's stored `client_version` is below the session's
//     `min_client_version` floor (the `readOnly` field on `RuntimeNodeRosterEntrySchema`; the server
//     derivation lives in
//     `packages/control-plane/src/runtime-nodes/attach-service.ts#readRoster`).
//     A below-floor node is ADMITTED read-only,
//     not ejected (I-003-1, Plan-003 §Invariants) — see the I-003-1 note below
//     for why the roster MUST never hide such a node. A node may be `online`
//     AND `readOnly` at once (the axes are independent); all are rendered.
//
// NEVER-MASK (`Spec-003 §Default Behavior`): the two HEALTH axes (`state`, `healthState`)
// have distinct owners — the slot axis vs the heartbeat sweep — and this view
// renders BOTH, verbatim, side by side. It computes NO collapsed/"effective"
// health scalar, so a recovery on one axis can never mask a degradation on the
// other; the wire itself carries no collapsed scalar either (the BOTH-AXES
// STANCE note above
// `packages/contracts/src/runtime-node.ts#RuntimeNodeRosterRequest`), and
// reconciling the axes is deliberately this client's render-time concern,
// satisfied here by presenting both.
//
// Spec-003 coverage:
//   • `Spec-003 §Acceptance Criteria` AC2 ("a degraded or offline node remains distinguishable from
//     a healthy online node"): the per-node row renders BOTH health axes as
//     labeled indicators, and a `degraded`/`offline` node (on either axis) is
//     kept in the rendered set with those indicators rather than removed (see
//     the I-003-1 admit-not-eject note).
//   • `Spec-003 §Acceptance Criteria` AC3 ("multiple runtime nodes can coexist in one session
//     without changing session identity"): the roster renders a SET
//     (`nodes.map(...)`), not a singleton. The `sessionId` prop scopes the
//     read; the roster never mutates it, so adding a second (e.g. below-floor)
//     node changes the rendered set, not the session identity. This is the
//     MULTI-NODE requirement.
//   • `Spec-003 §Required Behavior` ("multiple runtime nodes per session"): same set-render
//     — the component is structurally a list over the session's attached
//     nodes, one entry per `runtime_node_attachments` row.
//   • `Spec-003 §Fallback Behavior` ("capability-validation failure keeps the node
//     degraded/offline, distinguishable from healthy"): a node that failed
//     capability validation arrives in the read with `state: "degraded"` (the
//     §Fallback-Behavior axis — capability-validation failure leaves the node
//     `degraded`, the LEAST-PRIVILEGE note on `healthChanges.state`); the roster surfaces it with the
//     degraded indicator alongside healthy peers. This view does NOT perform
//     the validation (that is the daemon/control-plane authority) — it
//     projects the resulting `state` distinguishably.
//
// I-003-1 (admit-not-eject) — what this roster MUST NOT do. T5.1 cites no
// invariant (it is a read-only projection), but I-003-1 (Plan-003 §Invariants,
// "a below-floor node stays JOINED and VISIBLE; it is never ejected") shapes a
// NEGATIVE requirement on the render: a `degraded`/`offline` node (on either
// health axis) and a `readOnly` (below-floor) node are ALL kept in the
// rendered set with their indicators — never filtered out. There is
// deliberately NO `.filter(...)` that drops a node by `state`, `healthState`,
// or `readOnly`; the roster renders every node the read returns (the server
// side is equally unfiltered — `Spec-003 §Interfaces And Contracts`'s "every row, no server-side
// hiding" visibility clause). A future reader must NOT add a "hide
// offline/below-floor nodes" filter: that would violate I-003-1's
// admit-not-eject guarantee and break the AC2 distinguishability this view
// exists to provide.
//
// WHERE THE READ LIVES, AND WHY IT IS NOT HERE. The snapshot-plus-change-signal
// design — subscribe first, then read; every push an OPAQUE trigger to re-read
// rather than a payload to merge; the out-of-order guard; the subject stamp that
// substitutes the not-read answer the moment the session or the transport moves — is
// `node-roster-reads.ts`. This file holds the RENDER, which is a total function over
// the three-state union that hook settles into. The seam itself names no wire: the
// registered procedure name and the presence event set are declared once in
// `console/bridge/runtime-nodes/runtime-node-roster.ts` and reach this view already resolved.
//
// Renderer-untrusted boundary (Spec-023 §Trust Stance) — this file imports ONLY:
//   • `react` — the renderer's UI engine; explicitly allowed.
//   • Type-only from `@ai-sidekicks/contracts` — the contracts package is
//     renderer-safe (no `node:*`, `electron`, or `fs`/`path`/`process` runtime
//     imports); the type-only form emits NO JS runtime import, so only the
//     type-graph view of the wire shapes reaches the renderer.
//   • The read seam beside it, which reaches `window.sidekicks` through no path of
//     its own either — a host composes the pair and hands it in.
// No `electron`, no `node:*`, no `./src/main/**`, no `./src/preload/**`, and no
// `@ai-sidekicks/client-sdk` (the Node-side `runtimeNodeClient.ts` SDK) —
// statically enforced via the `no-restricted-imports` rule in
// apps/desktop/eslint.config.mjs. (The `@ai-sidekicks/client-sdk` ban is
// structural since Plan-023 T-023p-1C-1 removed the package from this app's
// manifest — the specifier no longer resolves here, per the SessionBootstrap
// header.)

import type { SessionId } from "@ai-sidekicks/contracts";

import { useNodeRosterRead, type NodeRosterReads } from "./node-roster-reads.js";

/**
 * Props for {@link NodeRoster}.
 *
 * `sessionId` is the branded {@link SessionId} of the session whose node roster to
 * render. It matches `RuntimeNodeRosterRequest.sessionId`
 * (`packages/contracts/src/runtime-node.ts#RuntimeNodeRosterRequest`), so
 * `{ sessionId }` constructs a valid roster-read request with no cast. The read is
 * scoped to this id, and the roster NEVER mutates it — adding nodes changes the
 * rendered set, not the session identity (AC3). The id arrives as a prop (supplied by
 * the console's own mount), not from renderer-side discovery — the same prop-contract
 * posture as `ParticipantRoster`.
 *
 * `reads` is REQUIRED. This view resolves no transport of its own: a mount hands it
 * the pair it already resolved, which is what keeps the wire names in one production
 * home and this component out of the `window.sidekicks` business entirely.
 */
export interface NodeRosterProps {
  sessionId: SessionId;
  reads: NodeRosterReads;
}

/**
 * Renders the live roster of runtime nodes attached to a session: a loading
 * indicator while the initial snapshot is in flight, one row per node (id + slot
 * `state` + liveness `healthState`/`lastHeartbeatAt` + read-only/below-floor status)
 * once loaded, or the error envelope on failure — with a control that opens the
 * conversation again, which is the only path back from a subscription that never
 * opened. The roster refreshes itself as node health transitions — see the read
 * seam's own notes for the ordering.
 */
export function NodeRoster({ sessionId, reads }: NodeRosterProps): React.JSX.Element {
  const { viewState: rosterViewState, retry } = useNodeRosterRead(sessionId, reads);

  if (rosterViewState.kind === "loading") {
    // `aria-busy` announces the in-flight initial snapshot to assistive tech.
    return (
      <section aria-label="node-roster-loading" aria-busy="true">
        <p>Loading runtime nodes…</p>
      </section>
    );
  }

  if (rosterViewState.kind === "loaded") {
    // One row per node (AC3 set-render). Each row distinguishes all three wire
    // facets — the two HEALTH axes verbatim (never-mask, `Spec-003 §Default Behavior`)
    // plus the permission verdict:
    //   • slot `state` — `online` vs `degraded`/`offline`/`registering`/
    //     `revoked` (AC2 + the `Spec-003 §Fallback Behavior` capability-degrade
    //     distinguishability).
    //   • liveness `healthState` + `lastHeartbeatAt` — the sweep-owned
    //     presence verdict, rendered verbatim and SEPARATELY from `state` (no
    //     collapsed/"effective" scalar is computed, so a recovery on one axis
    //     never masks a degradation on the other). The pre-first-heartbeat
    //     `null` renders as an explicit "none" label, not a hidden field.
    //   • `readOnly` — at-floor (read-write) vs below-floor (read-only); the
    //     `data-read-only` attribute + label surface the below-floor verdict
    //     (I-003-1: the below-floor node is VISIBLE, not ejected).
    // No `.filter(...)` — every node the read returned is rendered
    // (admit-not-eject). `data-node-state` / `data-health-state` /
    // `data-read-only` expose the facets for the T5.4 manual smoke and for the
    // BL-131 component suite in `__tests__/` to assert distinguishability without
    // scraping prose. `data-health-state` is ABSENT exactly when the wire
    // value is `null` (React omits null-valued attributes) — the DOM mirrors
    // the LEFT-JOIN nullability verbatim rather than inventing a fourth enum
    // token.
    return (
      <section aria-label="node-roster-loaded">
        <ul>
          {rosterViewState.nodes.map((node) => (
            <li
              key={node.nodeId}
              data-node-state={node.state}
              data-health-state={node.healthState}
              data-read-only={node.readOnly}
            >
              <span>node id: {node.nodeId}</span>
              <span>state: {node.state}</span>
              <span>liveness: {node.healthState ?? "none (no heartbeat yet)"}</span>
              <span>last heartbeat: {node.lastHeartbeatAt ?? "none (no heartbeat yet)"}</span>
              <span>
                access: {node.readOnly ? "read-only (below version floor)" : "read-write"}
              </span>
            </li>
          ))}
        </ul>
      </section>
    );
  }

  // role="alert" so assistive tech announces the failure.
  //
  // The control beside it is the way back. A failed READ recovers on its own — the
  // subscription that survived pushes again — but a presence subscription that could
  // not be opened at all leaves nothing to push, and the read seam deliberately skips
  // the snapshot in that arm rather than rendering rows behind a dead channel. So
  // without this button the column stood on one line of error text until the session
  // or the transport changed, and a cap that clears in thirty seconds looked exactly
  // like a permanent refusal.
  return (
    <section aria-label="node-roster-error" role="alert">
      <p>
        {rosterViewState.error.name}: {rosterViewState.error.message}
      </p>
      <button type="button" onClick={retry}>
        Try again
      </button>
    </section>
  );
}
