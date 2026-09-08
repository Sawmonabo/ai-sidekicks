// What one agent may reach, as the console reads it — and nothing about whether a
// given call would be allowed.
//
// `Spec-023 §Console Design (Meridian)`'s tool-governance section makes the agent's
// tool allowlist the per-agent control over every tool source at once, the browser's
// page tool set included, and puts that control on the agent card. The list is
// applied AT SPAWN from the attach snapshot, which is why this projection reads the
// resolved configuration the attach echoed back and never the definition registry: a
// definition edited afterwards reaches no agent that is already attached.
//
// FOUR POSITIONS, NOT THREE. The registry's own vocabulary keeps three apart — an
// absent list means the driver's default set, an empty one means no tools, and a
// populated one means exactly those — and the roster read adds a fourth that is none
// of them: a reply carrying identity and lifecycle and NO resolved configuration has
// said nothing about tools at all. Folding that into "the driver's default set" would
// be the console answering a question nobody put, which is the one thing the position
// below exists to refuse.
//
// THE NAMES ARE NOT HERE, DELIBERATELY. The populated arm carries a COUNT and no
// list, because the resolved-configuration echo on the same card already renders the
// names through `ToolAllowlist`. A second rendering of one wire value is a second
// place it can be formatted differently, and the count is what the governance line
// actually needs to say.
//
// NO VERDICT IS COMPOSED ANYWHERE IN THIS MODULE. A node-wide switch withholds the
// page tool set from every spawn on the node and an allowlist cannot raise that
// ceiling, so "this agent can browse" is a conjunction of two facts one of which the
// card never reads. The line states each position and lets the daemon adjudicate,
// which is the same rule every other console surface follows.

import type { AgentRosterEntry } from "../../bridge/index.js";

/**
 * What the attach snapshot says this agent may reach.
 *
 * A discriminated union rather than `readonly string[] | undefined`, so the fourth
 * position — the roster reply that carried no configuration at all — is
 * representable, and so a renderer cannot reach the count on an arm that has none.
 */
export type AgentToolGrantPosition =
  /** The reply carried no resolved configuration. Nothing was said about tools. */
  | { readonly kind: "not-reported" }
  /** A configuration with no allowlist member: the driver's own default set. */
  | { readonly kind: "driver-default" }
  /** A present, empty allowlist: no tools at all, which somebody chose. */
  | { readonly kind: "no-tools" }
  /** A populated allowlist. The names are the echo's; this is how many. */
  | { readonly kind: "named"; readonly toolCount: number };

/**
 * Read one agent's grant off the attach echo.
 *
 * The two absences are separated at the top, because they are separated on the wire:
 * `resolvedConfiguration` absent is the roster answering less than the whole row, and
 * `toolAllowlist` absent inside a configuration that IS present is the registry's own
 * "the driver's default set".
 */
export function agentToolGrantPosition(agent: AgentRosterEntry): AgentToolGrantPosition {
  const resolved = agent.resolvedConfiguration;
  if (resolved === undefined) {
    return { kind: "not-reported" };
  }
  const allowlist = resolved.toolAllowlist;
  if (allowlist === undefined) {
    return { kind: "driver-default" };
  }
  if (allowlist.length === 0) {
    return { kind: "no-tools" };
  }
  return { kind: "named", toolCount: allowlist.length };
}
