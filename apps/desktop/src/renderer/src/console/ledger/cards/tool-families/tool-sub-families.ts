// The tool sub-family decision, as a slot rather than as a paragraph.
//
// WHAT WAS DECIDED, AND WHY IT NEEDED A HOME. `card-family.ts` refuses to read a tool
// FAMILY out of the tool's name: `ToolActivityPayload` carries `toolName`,
// `toolCallId` and `durationMs`, and no member says what kind of tool ran, so a
// console that decided "this one is an MCP call" from the string would be asserting a
// fact the daemon never sent. That refusal is right and it is not the whole answer.
// The design names six tool treatments, and until this module the decision not to
// build them lived in a comment — which meant the sub-family had no owner, no shape,
// and no place for the wire member to land when one is registered.
//
// SO THE DECISION IS A SLOT. The vocabulary is declared here as data, the reading is
// one function over the row's own payload, and the body is an owner slot another
// change fills. The row seat next door is the same arrangement one level up: a
// contract, a fixture shell, and a named owner who replaces it.
//
// THE READER IS FAIL-CLOSED IN BOTH DIRECTIONS, which is the property that makes it
// worth having before the member exists. An ABSENT declaration reads as no sub-family
// at all, which is every row the daemon sends today and is exactly the tool layout
// this console already draws. An UNRECOGNIZED one reads as unrecognized and says so —
// an unknown enum member renders as the explicit unrecognized badge and never as a
// guess, and collapsing it
// into "no sub-family" would be that guess wearing an absence's clothes.

import { readWireString } from "../../../core/index.js";
import { type OwnerSlotContract } from "../../../seats/index.js";

/**
 * The tool treatments the design names. Closed.
 *
 * Data rather than prose, so the set can be counted and a seventh treatment is an
 * edit here rather than a sentence somebody has to notice. The tuple is the
 * declaration and the union is derived from it — `card-family.ts`' rule about its own
 * family set, for its reason.
 */
export const TOOL_SUB_FAMILIES = [
  "command-output",
  "file-edit",
  "read-fold",
  "mcp",
  "web-search",
  "image",
] as const;

/** One tool treatment. Derived from the enumeration, never restated. */
export type ToolSubFamily = (typeof TOOL_SUB_FAMILIES)[number];

/**
 * The payload member that would declare a row's sub-family.
 *
 * NO REGISTERED PAYLOAD CARRIES IT. `ToolActivityPayload` declares `toolName`,
 * `toolCallId` and `durationMs` and nothing else, so the reader below answers
 * `undefined` for every row this console can receive today. It is named here rather
 * than left implicit because this is where the member lands when the timeline read
 * grows one — and because a constant is checkable, where a comment is not.
 */
export const TOOL_SUB_FAMILY_MEMBER = "toolSubFamily";

/** The member carrying an MCP call's server label, on the same footing. */
export const TOOL_SUB_FAMILY_SERVER_MEMBER = "mcpServerLabel";

/** The member carrying the call's typed argument summary, on the same footing. */
export const TOOL_SUB_FAMILY_ARGUMENTS_MEMBER = "toolArgumentSummary";

/** What one row declares about its own treatment. Two arms and no third. */
export type ToolSubFamilyReading =
  | {
      readonly kind: "declared";
      readonly subFamily: ToolSubFamily;
      /** The MCP server the call went to, where the row names one. */
      readonly serverLabel: string | undefined;
      /** The call's arguments as the wire summarized them, never re-parsed here. */
      readonly argumentSummary: readonly string[];
    }
  | {
      readonly kind: "unrecognized";
      /** Wire-verbatim, so the badge can print what the daemon actually sent. */
      readonly declared: string;
    };

/** What the slot's body is handed. */
export interface ToolSubFamilySlotProps {
  readonly reading: ToolSubFamilyReading;
}

/** The sub-family treatment. Returns `React.ReactNode` so the card renders it directly. */
export type ToolSubFamilyRenderer = (props: ToolSubFamilySlotProps) => React.ReactNode;

/**
 * Who owns the six treatments, what this card owes them, and when the shell dies.
 *
 * Developer-facing and never rendered, which is what `OwnerSlotContract` is for. It
 * names the FEATURE rather than the governance record that plans it: a string in
 * shipped code is read by whoever opens the file next.
 */
export const TOOL_SUB_FAMILY_SLOT: OwnerSlotContract = {
  owningTask: "the timeline subtree's tool sub-family treatments",
  mountObligation:
    "the tool card renders this beside the tool's name, given the row's own declared sub-family reading and nothing derived from the tool's name",
  deleteShellIn:
    "the change that registers a declared sub-family on the timeline read and builds the six treatments behind it",
};

/**
 * What one row declares about its treatment, or `undefined` for a row declaring none.
 *
 * Over the PROJECTED PAYLOAD rather than over the row, so the caller reads the
 * payload once and both this and the tool's name come out of the same object — the
 * card already holds it, and a second projection per row would walk the same record
 * twice on every frame of a scrolling log.
 */
export function declaredToolSubFamily(
  payload: Readonly<Record<string, unknown>>,
): ToolSubFamilyReading | undefined {
  const declared = readWireString(payload[TOOL_SUB_FAMILY_MEMBER]);
  if (declared === undefined) {
    return undefined;
  }
  if (!isToolSubFamily(declared)) {
    return { kind: "unrecognized", declared };
  }
  return {
    kind: "declared",
    subFamily: declared,
    serverLabel: readWireString(payload[TOOL_SUB_FAMILY_SERVER_MEMBER]),
    argumentSummary: readArgumentSummary(payload[TOOL_SUB_FAMILY_ARGUMENTS_MEMBER]),
  };
}

/** Whether a wire string is one of the six. A membership test, never a coercion. */
function isToolSubFamily(candidate: string): candidate is ToolSubFamily {
  return (TOOL_SUB_FAMILIES as readonly string[]).includes(candidate);
}

/**
 * The argument summary the wire supplied, as strings.
 *
 * Every element read through the same wire-string reader the rest of this family
 * uses, and an element that is not a string is DROPPED rather than stringified: a
 * summary is what the daemon composed, and `String(value)` on an object would put
 * `[object Object]` on the page as though the daemon had sent it.
 */
function readArgumentSummary(candidate: unknown): readonly string[] {
  if (!Array.isArray(candidate)) {
    return EMPTY_ARGUMENT_SUMMARY;
  }
  const summary: string[] = [];
  for (const element of candidate) {
    const text = readWireString(element);
    if (text !== undefined) {
      summary.push(text);
    }
  }
  return summary;
}

/** No arguments at all. One frozen value, so the ordinary row allocates none. */
const EMPTY_ARGUMENT_SUMMARY: readonly string[] = Object.freeze([]);
