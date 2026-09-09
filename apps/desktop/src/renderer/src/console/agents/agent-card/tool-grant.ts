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
// ONE POSITION, ONE READING, ON BOTH SURFACES THAT STATE IT. The card says what this
// agent may reach twice — the governance line above the disclosure and the Tools row
// inside it — and each of them used to read the wire for itself: the line read this
// projection and the row read `toolAllowlist` alone, which cannot tell a
// configuration that carried no allowlist from a reply that carried no configuration.
// So one wire state was called "the driver's default set" on the line and "not
// reported" a few pixels below it. Both now read this module: the position is
// resolved once by the card, the words for each position are the table below, and the
// names ride the populated arm so neither surface re-reads the member.
//
// WHAT EACH SURFACE DOES WITH IT IS STILL DIFFERENT, and that is the split rather
// than a duplication. The line states the position at length, because a governance
// ceiling a reader has to open a disclosure to find is a ceiling nobody reads; the
// row inside the disclosure names the tools, because that is what the echo is for,
// and says the SHORT reading where a position names none. The line renders a count
// and never the names — `ToolGrantLine.test.tsx` holds that.
//
// NO VERDICT IS COMPOSED ANYWHERE IN THIS MODULE. A node-wide switch withholds the
// page tool set from every spawn on the node and an allowlist cannot raise that
// ceiling, so "this agent can browse" is a conjunction of two facts one of which the
// card never reads. The words state each position and let the daemon adjudicate,
// which is the same rule every other console surface follows.

import { TOOL_ALLOWLIST_NAMED_CAP } from "../../core/index.js";
import { formatCount } from "../../primitives/index.js";
import type { AgentRosterEntry } from "../../bridge/index.js";

/**
 * What the attach snapshot says this agent may reach.
 *
 * A discriminated union rather than `readonly string[] | undefined`, so the fourth
 * position — the roster reply that carried no configuration at all — is
 * representable, and so a renderer cannot reach the names on an arm that has none.
 */
export type AgentToolGrantPosition =
  /** The reply carried no resolved configuration. Nothing was said about tools. */
  | { readonly kind: "not-reported" }
  /** A configuration with no allowlist member: the driver's own default set. */
  | { readonly kind: "driver-default" }
  /** A present, empty allowlist: no tools at all, which somebody chose. */
  | { readonly kind: "no-tools" }
  /** A populated allowlist, carrying the names the echo renders. Never empty. */
  | { readonly kind: "named"; readonly toolNames: readonly string[] };

/** How a reading is weighted: an absence nobody chose, or a restriction somebody did. */
export type ToolGrantWeight = "absent" | "derived";

/** What one position says, in the console's own words, wherever it is said. */
export interface AgentToolGrantWording {
  /** The short reading: the whole of what the echo's Tools row says for this position. */
  readonly reading: string;
  /** The same position at length, which is what the governance line states. */
  readonly lineSentence: string;
  readonly weight: ToolGrantWeight;
}

/** The three positions that name no tool, which are the three the table below words. */
type NamelessToolGrantKind = Exclude<AgentToolGrantPosition, { readonly kind: "named" }>["kind"];

/**
 * The words for every position that names no tool.
 *
 * Total over {@link NamelessToolGrantKind} by construction, so a fifth nameless
 * position fails to compile here before it can reach a surface that renders it. The
 * populated arm is deliberately absent: its sentence carries a figure and a cap, so
 * it is composed by {@link namedToolGrantSentence} rather than stored.
 */
export const NAMELESS_TOOL_GRANT_WORDING: Readonly<
  Record<NamelessToolGrantKind, AgentToolGrantWording>
> = {
  // Muted, because nobody asked: this is "no question was put", never "no tools".
  "not-reported": {
    reading: "Not reported",
    lineSentence:
      "This roster reply carried identity and lifecycle and no resolved configuration, so what this agent may reach was not answered.",
    weight: "absent",
  },
  // Muted, like every other axis whose absence MEANS something: nobody restricted
  // this agent, and the driver's own set is what it was spawned with.
  "driver-default": {
    reading: "The driver's default set",
    lineSentence: "The driver's default tool set. Nothing was withheld at attach.",
    weight: "absent",
  },
  // Full weight, because an empty allowlist is a restriction somebody chose and is
  // the strictest posture an agent can carry — never an absence.
  "no-tools": {
    reading: "No tools",
    lineSentence: "No tools. This agent was attached with an empty allowlist.",
    weight: "derived",
  },
};

/**
 * What the governance line says about a populated allowlist.
 *
 * TAKES THE NAMES RATHER THAN A COUNT, so a caller cannot hand it a figure that
 * disagrees with the list the disclosure renders.
 *
 * TWO THINGS IT REFUSES TO PROMISE. An explicit one-tool arm, because the console has
 * one figure formatter and no pluralizer: a count folded into prose has to agree with
 * its noun, and `${formatCount(1)} tools` reads "the 1 tools" — the same arm
 * `sessions/notifications/attention-sentences.ts` takes for one session. And a list
 * longer than the echo's own cap is not promised whole: the disclosure names the
 * first {@link TOOL_ALLOWLIST_NAMED_CAP} and folds the rest to a figure, so a line
 * saying all fifteen are "named below" would be describing a surface that is not
 * there. The cap is read from its one home rather than spelled here.
 */
export function namedToolGrantSentence(toolNames: readonly string[]): string {
  if (toolNames.length === 1) {
    return "Restricted to the one tool it was attached with, named in the resolved configuration below.";
  }
  const restriction = `Restricted to the ${formatCount(toolNames.length)} tools it was attached with`;
  return toolNames.length > TOOL_ALLOWLIST_NAMED_CAP
    ? `${restriction}; the first ${formatCount(TOOL_ALLOWLIST_NAMED_CAP)} are named in the resolved configuration below.`
    : `${restriction}, named in the resolved configuration below.`;
}

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
  return { kind: "named", toolNames: allowlist };
}
