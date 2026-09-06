// The access verdict a roster row resolves to, and the words for each one.
//
// Split out of `MixedVersionStatus.tsx` because it is a FOLD rather than a
// rendering: `resolveAccessStatus` is total over the roster entry alone, so every
// case that matters — a revoked row that must not read as merely detached, an
// at-floor `degraded` row that must stay read-write, the absent row — is one call
// instead of a mounted component. The exhaustiveness binding in its `default` arm is
// the load-bearing part, and a compile-time claim is easier to see in a module whose
// whole subject is the verdict.
//
// THE VERDICT IS A FUNCTION OF THE ROSTER ENTRY AND OF NOTHING ELSE. The
// write-refusal prop is deliberately not a parameter here: a refusal envelope is not
// a second floor source, and the module boundary is what makes that unarguable rather
// than merely documented.

import type { RuntimeNodeRosterEntry } from "@ai-sidekicks/contracts";

// The four-token access verdict — the AC4 three-way distinction (read-only /
// read-write / detached) plus the honest `revoked` fourth (see the header's
// revoked-vs-detached note). These are the machine tokens the
// `data-access-status` facet carries for the T5.4 manual smoke and for the
// BL-131 component suite in `__tests__/MixedVersionStatus.verdict.test.tsx`, which
// asserts all four.
export type NodeAccessStatus = "read-write" | "read-only" | "detached" | "revoked";

// Human labels per verdict. The two ATTACHED labels are byte-identical to the
// sibling access wording (the access label in the loaded-branch row of
// `NodeRoster.tsx#NodeRoster`; the same in `AttachFlow.tsx#AttachFlow`'s
// resolved branch) so the three runtime-node views read consistently in the
// T5.4 smoke; the two RETIRED labels state the
// load-bearing difference between the terminal states (reconnect-allowed vs
// re-attach-refused — `Spec-003 §Fallback Behavior` and `Spec-003 §Default Behavior`).
export const ACCESS_STATUS_LABELS: Record<NodeAccessStatus, string> = {
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
//     exactly the ACTIVE attachment set (I-003-5, `Plan-003 §Invariants`:
//     "offline and revoked are inactive"; the `idx_node_attachments_active`
//     partial-index predicate), so the verdict is the PERMISSION axis
//     verbatim: `readOnly` distinguishes below-floor from at-floor. Liveness
//     and slot-health rendering stay the sibling NodeRoster's mandate — this
//     indicator surfaces the ACCESS axis, and the raw `state` stays
//     machine-visible on the `data-node-state` facet, so nothing is masked by
//     the focus.
//   • The `default` arm is a COMPILE-TIME EXHAUSTIVENESS BINDING (see its
//     inline note): without it, a fall-through would silently misclassify a
//     future sixth `NodeState` member as ACTIVE.
export function resolveAccessStatus(rosterEntry: RuntimeNodeRosterEntry | null): NodeAccessStatus {
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
      // additions are reserved as MINOR by the contract (the `NodeState` set-membership
      // note in runtime-node.ts; ADR-018 §Decision #8 — "removals MAJOR, additions MINOR"), so
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
