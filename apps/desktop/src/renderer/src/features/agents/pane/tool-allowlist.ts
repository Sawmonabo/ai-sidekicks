// What one agent may reach, as the console reads it; it says nothing about whether a call would
// be allowed. The list is applied at spawn from the resolved configuration, so this reads the
// roster's configuration and never the definition registry: a later edit reaches no running
// agent. There are four positions: the registry's three (null is the provider's default set,
// empty is no tools, populated is exactly those) plus an agent not started from a saved
// definition, which carries no configuration and so says nothing about tools. The card resolves
// the position once and the grant line and the echo's Tools row both read it. No verdict is
// composed: a node-wide switch can withhold the page tool set regardless of the allowlist, so
// the words state each position and leave the daemon to adjudicate.

import { TOOL_ALLOWLIST_NAMED_CAP } from "../agents-caps.js";
import { formatCount } from "@renderer/lib/wire-figures.js";
import type { AgentListEntry } from "@ai-sidekicks/contracts";

/**
 * What the resolved configuration says this agent may reach. A union so the "no configuration"
 * position is representable and a renderer cannot reach names on an arm that has none.
 */
export type AgentToolAllowlistPosition =
  /** The agent carries no resolved configuration. Nothing was said about tools. */
  | { readonly kind: "not-reported" }
  /** A configuration whose allowlist is null: the provider's own default set. */
  | { readonly kind: "driver-default" }
  /** A present, empty allowlist: no tools at all, which somebody chose. */
  | { readonly kind: "no-tools" }
  /** A populated allowlist, carrying the names the echo renders. Never empty. */
  | { readonly kind: "named"; readonly toolNames: readonly string[] };

/** How a reading is weighted: an absence nobody chose, or a restriction somebody did. */
export type ToolAllowlistWeight = "absent" | "derived";

/** What one position says, in the console's own words, wherever it is said. */
export interface AgentToolAllowlistWording {
  /** The short reading: the whole of what the echo's Tools row says for this position. */
  readonly reading: string;
  /** The same position at length, which is what the governance line states. */
  readonly lineSentence: string;
  readonly weight: ToolAllowlistWeight;
}

/** The three positions that name no tool, which are the three the table below words. */
type NamelessToolGrantKind = Exclude<
  AgentToolAllowlistPosition,
  { readonly kind: "named" }
>["kind"];

/**
 * The words for every position that names no tool. Total over {@link NamelessToolGrantKind}, so
 * a new nameless position fails to compile. The populated arm is composed by
 * {@link namedToolAllowlistSentence} because its sentence carries a figure and a cap.
 */
export const NAMELESS_TOOL_ALLOWLIST_WORDING: Readonly<
  Record<NamelessToolGrantKind, AgentToolAllowlistWording>
> = {
  // Muted, because nobody asked: this is "no question was put", never "no tools".
  "not-reported": {
    reading: "Not reported",
    lineSentence:
      "This agent was not started from a saved definition, so the roster does not say what it may reach.",
    weight: "absent",
  },
  // Muted: nobody restricted this agent, and the provider's own set is what it spawned with.
  "driver-default": {
    reading: "The provider's default set",
    lineSentence: "The provider's default tool set.",
    weight: "absent",
  },
  // Full weight: an empty allowlist is a restriction somebody chose, never an absence.
  "no-tools": {
    reading: "No tools",
    lineSentence: "No tools.",
    weight: "derived",
  },
};

/**
 * What the governance line says about a populated allowlist. Takes the names, not a count, so
 * the figure cannot disagree with the list the disclosure renders. It has an explicit one-tool
 * arm because there is no pluralizer, and it does not promise a list longer than
 * {@link TOOL_ALLOWLIST_NAMED_CAP} is named whole: the disclosure names only the first few.
 */
export function namedToolAllowlistSentence(toolNames: readonly string[]): string {
  if (toolNames.length === 1) {
    return "Restricted to the one tool, named in the resolved configuration below.";
  }
  const restriction = `Restricted to the ${formatCount(toolNames.length)} tools`;
  return toolNames.length > TOOL_ALLOWLIST_NAMED_CAP
    ? `${restriction}; the first ${formatCount(TOOL_ALLOWLIST_NAMED_CAP)} are named in the resolved configuration below.`
    : `${restriction}, named in the resolved configuration below.`;
}

/**
 * Read one agent's grant off its resolved configuration. Absent `resolvedConfiguration` is an
 * agent not started from a saved definition; `toolAllowlist` null inside a present configuration
 * is the registry's "provider's default set".
 */
export function agentToolAllowlistPosition(agent: AgentListEntry): AgentToolAllowlistPosition {
  const resolved = agent.resolvedConfiguration;
  if (resolved === undefined) {
    return { kind: "not-reported" };
  }
  const allowlist = resolved.toolAllowlist;
  if (allowlist === null) {
    return { kind: "driver-default" };
  }
  if (allowlist.length === 0) {
    return { kind: "no-tools" };
  }
  return { kind: "named", toolNames: allowlist };
}
