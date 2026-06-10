// Plan-003 Phase 5 T5.2 (Tier 3) — renderer CapabilityDeclaration component.
//
// A PRESENTATIONAL view over a runtime node's declared capability map — the
// `capabilities` field of the attach payload (`RuntimeNodeAttachRequest`,
// runtime-node.ts:124-131; the field at :129, realized as the interim-opaque
// two-arg `z.record(z.string(), z.unknown())` at :164). `AttachFlow` composes
// it so the user sees what the node declares BEFORE and WHILE it attaches
// (Spec-003 line 48 — "Attach must include node identity, declared
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
//     (Spec-003 line 57 — a node defaults `online` only after capability
//     declaration succeeds; Plan-003 §Invariants I-003-2). A future editor
//     must NOT add capability validation here: a capability-validation
//     FAILURE surfaces as the node's `degraded`/`offline` state on the
//     roster's slot axis (Spec-003 line 76; rendered by the sibling
//     NodeRoster), never as this view second-guessing the declared map.
//   • Capability VALUES are interim-opaque `unknown` until Plan-006 Tier 4
//     binds the canonical `CapabilityDetails` over the capability fields
//     (runtime-node.ts:658-659; the `Plan-006-Tier-4-binds-canonical` markers
//     there, e.g. :957-965). The indexed-access prop type below makes this
//     view follow that tightening automatically.
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
// `@ai-sidekicks/client-sdk` ban is by-convention at Tier 1, per the
// SessionBootstrap header).

import type { RuntimeNodeAttachRequest } from "@ai-sidekicks/contracts";

/**
 * Props for {@link CapabilityDeclaration}.
 *
 * `capabilities` is the node's declared capability map, typed by INDEXED
 * ACCESS off the shipped wire contract (`RuntimeNodeAttachRequest`,
 * runtime-node.ts:124-131) rather than a re-declared local
 * `Record<string, unknown>`: when Plan-006 Tier 4 tightens the contract field
 * to the canonical `CapabilityDetails`, this prop follows with no edit here.
 */
export interface CapabilityDeclarationProps {
  capabilities: RuntimeNodeAttachRequest["capabilities"];
}

// Never-throwing lossy fallback for values `JSON.stringify` cannot render.
// Bare `String(...)` is NOT total: it runs ToPrimitive, which itself throws
// for a null-prototype object — or null-prototype FUNCTION — carrying no
// `toString`/`valueOf`/`Symbol.toPrimitive`, so it gets an inner guard. The
// terminal fallback is a string LITERAL, deliberately not
// `Object.prototype.toString.call(...)`: even that can throw (its
// `Symbol.toStringTag` lookup is a Get, and a hostile getter propagates), so
// only a literal makes the totality claim PROVABLE rather than merely one
// pathological layer deeper.
function lossyStringify(declaredValue: unknown): string {
  try {
    return String(declaredValue);
  } catch {
    return "[unrepresentable value]";
  }
}

// Total formatter for an interim-opaque capability value. Wire-borne
// capability maps are JSON by construction (they arrived through JSON
// serialization), but the PROP boundary admits arbitrary `unknown` at Tier 3
// (the map is supplied by a parent/future router, not read off the wire by
// this view), so the formatter must be TOTAL — a pathological value degrades
// to a lossy string, never crashes the render:
//   • a plain string renders verbatim (no JSON quoting noise);
//   • everything else rides `JSON.stringify`, whose two non-string outcomes
//     BOTH route through the never-throwing `lossyStringify` above — it
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
 * state for the empty map — the least-privilege default (Spec-003 line 58)
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
    // for the T5.4 manual smoke (and future BL-131 automated coverage).
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
