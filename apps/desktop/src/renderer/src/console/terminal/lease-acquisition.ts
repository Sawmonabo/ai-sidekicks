// Whether this window may take the shell, and what stands where the control does not.
//
// A FOLD RATHER THAN A CONDITION IN THE LINE, on `lease-claim.ts`'s rule: the lease
// line RENDERS, and the moment it acquires a rule that rule belongs somewhere it can
// be driven without mounting React. This one has six outcomes over two reads and a
// holding, which is exactly the shape that rots into nested ternaries in a component.
//
// WHY A ROLE AT ALL, WHEN THE IDENTITY WAS ALREADY BEING READ. `session.takeControl`
// is owner/collaborator-only (`Spec-003 §Required Behavior`), and the surface used to
// offer "Claim the shell" to anybody whose identity had been read. A viewer or a
// runtime contributor was therefore shown a control whose only possible answer is
// `pty.permission_denied` — an offer the daemon exists to refuse, which
// `Spec-023 §Console Design (Meridian)` rule 9 rules out: a control that cannot act is
// neither an offer nor a refusal.
//
// THE TWO READS ANSWER TWO QUESTIONS AND ARE NOT FOLDED TOGETHER. The identity is what
// the lease fold compares the holder against — it is how `held-by-you` is told from
// `held-by-another` — and the role is what the daemon will check. Neither substitutes
// for the other: an identity without a role cannot say whether the take is permitted,
// and a role without an identity cannot say whose hold is on screen.
//
// RELEASE IS NOT GATED, and that is deliberate. A holder whose role has just been
// lowered still holds the shell until a transition says otherwise, and the wire's own
// authorization change reaches this pane as an event, not as a promise about ordering.
// Taking the release control away in that interval would strand the keyboard on a
// participant with no way to hand it back.

import type { MembershipRole } from "@ai-sidekicks/contracts";

import type { ConsoleRefusal } from "../core/index.js";
import type { CallerMembershipRoleResult } from "../store/index.js";
import type { TerminalLeaseHolding } from "./lease-model.js";
import type { TerminalViewerIdentity } from "./viewer-identity.js";

/**
 * The roles the registered take admits.
 *
 * A TUPLE AND NOT A `Set`, on `browser/geometry-publisher.ts`'s
 * `CLIPPING_OVERFLOW_VALUES` shape. `apps/desktop/AGENTS.md` rejects a module-level
 * collection singleton, and the rule is right about this one rather than merely
 * applying to it: `ReadonlySet<MembershipRole>` restricted the BINDING while the
 * collection under it stayed mutable for the life of the process, and two frozen
 * literals need no hash table to be compared against.
 *
 * The contract's own role union stays the ground truth, and the assertion that ties
 * the two together sits in the co-located test rather than in a `satisfies` clause
 * here: this package compiles under `isolatedDeclarations`, which admits a bare
 * `as const` on an exported binding and refuses one carrying a `satisfies`, because
 * that clause cannot be resolved without the checker. So the tuple is exported plain
 * and the test asserts its element type extends `MembershipRole` — a role spelt
 * wrong is a compile error there rather than an entry that silently matches nothing,
 * which would take the control away from somebody entitled to it and say nothing.
 */
export const ACQUIRING_MEMBERSHIP_ROLES = ["owner", "collaborator"] as const;

/** Why no acquisition control is offered. Each arm is a different sentence. */
export type TerminalClaimWithholding =
  /** The identity read is still out. Nothing has been established yet. */
  | { readonly reason: "identity-not-read" }
  | { readonly reason: "identity-refused"; readonly refusal: ConsoleRefusal }
  /** The role read is still out — the identity landed, the entitlement has not. */
  | { readonly reason: "role-not-read" }
  | { readonly reason: "role-refused"; readonly refusal: ConsoleRefusal }
  /** The read landed and the roster names no role for this participant. */
  | { readonly reason: "role-unread-in-roster" }
  /** The role landed and it is not one the take admits. */
  | { readonly reason: "role-cannot-acquire"; readonly role: MembershipRole };

/** Which control the lease line offers, or the reason it offers none. */
export type TerminalClaimAffordance =
  | { readonly control: "release" }
  | { readonly control: "acquire" }
  | { readonly control: "none"; readonly withheld: TerminalClaimWithholding };

/**
 * Resolve the one control 8.8 allows this surface, from the holding and the two reads.
 *
 * Release comes FIRST and unconditionally. A viewer cannot take the shell, but a
 * participant who holds it is holding it whatever the roster says right now, and the
 * only way back is this control.
 */
export function resolveTerminalClaimAffordance(input: {
  readonly holding: TerminalLeaseHolding;
  readonly viewerIdentity: TerminalViewerIdentity;
  readonly callerRole: CallerMembershipRoleResult;
}): TerminalClaimAffordance {
  if (input.holding === "held-by-you") {
    return { control: "release" };
  }
  const withheld = withholdingFor(input.viewerIdentity, input.callerRole);
  return withheld === undefined ? { control: "acquire" } : { control: "none", withheld };
}

/** The first thing missing, or `undefined` when nothing is. */
function withholdingFor(
  viewerIdentity: TerminalViewerIdentity,
  callerRole: CallerMembershipRoleResult,
): TerminalClaimWithholding | undefined {
  if (viewerIdentity.status === "not-loaded") {
    return { reason: "identity-not-read" };
  }
  if (viewerIdentity.status === "refused") {
    return { reason: "identity-refused", refusal: viewerIdentity.refusal };
  }
  if (callerRole.status === "not-loaded") {
    return { reason: "role-not-read" };
  }
  if (callerRole.status === "refused") {
    return { reason: "role-refused", refusal: callerRole.refusal };
  }
  const role = callerRole.role;
  if (role === undefined) {
    return { reason: "role-unread-in-roster" };
  }
  return ACQUIRING_MEMBERSHIP_ROLES.some((acquiringRole) => acquiringRole === role)
    ? undefined
    : { reason: "role-cannot-acquire", role };
}
