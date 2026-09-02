// Plan-003 Phase 5 T5.2 (Tier 3) — renderer CapabilityDeclaration component.
//
// A PRESENTATIONAL view over a runtime node's declared capability map — the
// `capabilities` field of the attach payload (the `RuntimeNodeAttachRequest`
// interface in runtime-node.ts, realized on `RuntimeNodeAttachRequestSchema`
// as the interim-opaque two-arg `z.record(z.string(), z.unknown())`).
// `AttachFlow` composes
// it so the user sees what the node declares BEFORE and WHILE it attaches
// (`Spec-003 §Required Behavior` — "Attach must include node identity, declared
// capabilities, health, and trust context"); the prop contract is the
// contract shape itself, so the view is equally consumable standalone (e.g. a
// future roster-detail surface rendering an attached node's
// `RuntimeNodeRosterEntry.capabilities`, which carries the same record shape).
//
// Spec-003 coverage:
//   • Line 48 ("attach includes … declared capabilities"): this view IS the
//     render of the declared-capability component of the attach payload — one
//     row per declared capability name, with the value formatted verbatim,
//     never dropped.
//   • Line 58 ("node capability exposure defaults to least privilege: only
//     explicitly declared capabilities are schedulable"): the EMPTY map
//     renders as an explicit "nothing declared / nothing schedulable" state,
//     never as silent blankness — an empty declared set is a meaningful
//     least-privilege fact (the node exposes NO schedulable capability), not
//     a missing one.
//
// DELIBERATELY PRESENTATIONAL — no bridge access, no state, no effects. The
// capability map arrives as a prop; this view renders what is DECLARED and
// neither validates nor declares:
//   • Declaration AUTHORITY is the daemon-side node-capability service
//     (`Spec-003 §Default Behavior` — a node defaults `online` only after capability
//     declaration succeeds; Plan-003 §Invariants I-003-2). A future editor
//     must NOT add capability validation here: a capability-validation
//     FAILURE surfaces as the node's `degraded`/`offline` state on the
//     roster's slot axis (`Spec-003 §Fallback Behavior`; rendered by the sibling
//     NodeRoster), never as this view second-guessing the declared map.
//   • The attach payload's capability VALUES stay interim-opaque `unknown`.
//     Plan-006 T1.4 bound the canonical `CapabilityDetails` over the
//     `runtime_node.capability_*` EVENT-payload fields only — NOT over this
//     attach map. Tightening the declared-capability map to that canonical
//     shape stays Plan-006 Tier 4's step (the forward-compatibility note on
//     `RuntimeNodeRegisteredPayload.capabilities` in runtime-node.ts records
//     it, on the field that mirrors this one VERBATIM). The indexed-access
//     prop type below makes this view follow that tightening automatically
//     when it lands.
//
// Renderer-untrusted boundary (Spec-023 §Trust Stance) — this file imports
// ONLY type-only from `@ai-sidekicks/contracts` (the contracts package is
// renderer-safe; the type-only form emits NO JS runtime import, so only the
// type-graph view of the wire shape reaches the renderer). It needs no
// `react` value import: there are no hooks, and JSX compiles via the
// automatic runtime (`jsx: "react-jsx"` in the renderer tsconfig), which
// injects its own `react/jsx-runtime` import at build time. No `electron`,
// no `node:*`, no `./src/main/**`, no `./src/preload/**`, and no
// `@ai-sidekicks/client-sdk` — statically enforced via the
// `no-restricted-imports` rule in apps/desktop/eslint.config.mjs (the
// `@ai-sidekicks/client-sdk` ban is structural since Plan-023 T-023p-1C-1
// removed the package from this app's manifest, per the SessionBootstrap
// header).

import type { RuntimeNodeAttachRequest } from "@ai-sidekicks/contracts";

// The never-throwing stringifier lives once, in `src/shared/`, for every
// renderer surface and both Electron processes (Plan-023 Phase 1B). This file
// authored the original and a sibling copied it verbatim under a comment
// saying so; the body is now imported by both.
import { lossyStringify } from "../../../shared/wire-errors.js";

/**
 * Props for {@link CapabilityDeclaration}.
 *
 * `capabilities` is the node's declared capability map, typed by INDEXED
 * ACCESS off the shipped wire contract (the `RuntimeNodeAttachRequest`
 * interface in runtime-node.ts) rather than a re-declared local
 * `Record<string, unknown>`: when Plan-006 Tier 4 tightens the contract field
 * to the canonical `CapabilityDetails`, this prop follows with no edit here.
 */
export interface CapabilityDeclarationProps {
  capabilities: RuntimeNodeAttachRequest["capabilities"];
}

// Total formatter for an interim-opaque capability value. Wire-borne
// capability maps are JSON by construction (they arrived through JSON
// serialization), but the PROP boundary admits arbitrary `unknown` at Tier 3
// (the map is supplied by a parent/future router, not read off the wire by
// this view), so the formatter must be TOTAL — a pathological value degrades
// to a lossy string, never crashes the render:
//   • a plain string renders verbatim (no JSON quoting noise);
//   • everything else rides `JSON.stringify`, whose two non-string outcomes
//     BOTH route through the never-throwing shared `lossyStringify` — it
//     returns `undefined` (not a string) for `undefined`/function/symbol
//     inputs, and it THROWS on circular references and `BigInt`.
// The two fallback paths share that one guarded helper because BOTH can
// carry a value bare `String(...)` chokes on: the throw path via a circular
// null-prototype object, and the `undefined`-return path via a
// null-prototype function (`JSON.stringify` returns `undefined` for ANY
// function, prototype or not, and `String` on a null-prototype one fails
// ToPrimitive the same way).
function formatCapabilityValue(declaredValue: unknown): string {
  if (typeof declaredValue === "string") return declaredValue;
  try {
    return JSON.stringify(declaredValue) ?? lossyStringify(declaredValue);
  } catch {
    return lossyStringify(declaredValue);
  }
}

/**
 * Renders a runtime node's declared capability set: one row per declared
 * capability (name + formatted value), or an explicit "nothing declared"
 * state for the empty map — the least-privilege default (`Spec-003 §Default Behavior`)
 * is a fact worth rendering, not blank space.
 *
 * Purely presentational: no bridge access, no hooks — see the file header
 * for why declaration authority stays daemon-side.
 */
export function CapabilityDeclaration({
  capabilities,
}: CapabilityDeclarationProps): React.JSX.Element {
  // Entries render in the map's own key order — a faithful projection of the
  // declared set as carried, not sorted or editorialized (the same verbatim
  // posture as NodeRoster's unfiltered node set).
  const capabilityEntries = Object.entries(capabilities);

  if (capabilityEntries.length === 0) {
    // `data-capability-count={0}` keeps the empty state machine-assertable
    // for the T5.4 manual smoke and for the BL-131 component suite in
    // `__tests__/CapabilityDeclaration.test.tsx`, which asserts it.
    return (
      <section aria-label="capability-declaration-empty" data-capability-count={0}>
        <p>No capabilities declared — nothing on this node is schedulable.</p>
      </section>
    );
  }

  // `data-capability-count` + per-row `data-capability` expose the declared
  // set for the T5.4 manual smoke without scraping prose (the NodeRoster
  // `data-*` facet precedent).
  return (
    <section aria-label="capability-declaration" data-capability-count={capabilityEntries.length}>
      <ul>
        {capabilityEntries.map(([capabilityName, declaredValue]) => (
          <li key={capabilityName} data-capability={capabilityName}>
            <span>capability: {capabilityName}</span>
            <span>declared as: {formatCapabilityValue(declaredValue)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
