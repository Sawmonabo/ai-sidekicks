// The tool sub-family vocabulary and the reader over a row's own payload.
//
// `row-kind.ts` refuses to read a tool kind out of the tool's name:
// `ToolActivityPayload` carries `toolName`, `toolCallId` and `durationMs`, and no member
// says what kind of tool ran, so deciding "this one is an MCP call" from the string would
// assert a fact the daemon never sent. The design names six tool treatments, so the
// vocabulary is declared here as data and the reading is one function over the payload.
//
// The reader is fail-closed in both directions. An ABSENT declaration reads as no
// sub-family, which is the tool layout this console already draws. An UNRECOGNIZED one
// reads as unrecognized and says so: an unknown enum member renders as the explicit
// unrecognized badge and never as a guess, and collapsing it into "no sub-family" would
// be that guess wearing an absence's clothes.

import { readWireString } from "@renderer/lib/wire-strings.js";

/**
 * The tool treatments the design names. Closed.
 *
 * Data rather than prose, so the set can be counted and a seventh treatment is an
 * edit here rather than a sentence somebody has to notice. The tuple is the
 * declaration and the union is derived from it — `row-kind.ts`' rule about its own
 * family set, for its reason.
 */
export const TOOL_KINDS = [
  "command-output",
  "file-edit",
  "read-fold",
  "mcp",
  "web-search",
  "image",
] as const;

/** One tool treatment. Derived from the enumeration, never restated. */
export type ToolKind = (typeof TOOL_KINDS)[number];

/**
 * The payload member that would declare a row's sub-family.
 *
 * NO REGISTERED PAYLOAD CARRIES IT. `ToolActivityPayload` declares `toolName`,
 * `toolCallId` and `durationMs` and nothing else, so the reader below answers
 * `undefined` for every row this console can receive today. It is named here rather
 * than left implicit because this is where the member lands when the timeline read
 * grows one — and because a constant is checkable, where a comment is not.
 */
export const TOOL_KIND_PAYLOAD_KEY = "toolSubFamily";

/** The member carrying an MCP call's server label, on the same footing. */
export const TOOL_SERVER_LABEL_PAYLOAD_KEY = "mcpServerLabel";

/** The member carrying the call's typed argument summary, on the same footing. */
export const TOOL_ARGUMENT_SUMMARY_PAYLOAD_KEY = "toolArgumentSummary";

/** What one row declares about its own treatment. Two arms and no third. */
export type ToolKindReading =
  | {
      readonly kind: "declared";
      readonly subFamily: ToolKind;
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

/** What a sub-family renderer is handed. */
export interface ToolKindRendererProps {
  readonly reading: ToolKindReading;
}

/** The sub-family treatment. Returns `React.ReactNode` so the card renders it directly. */
export type ToolKindRenderer = (props: ToolKindRendererProps) => React.ReactNode;

/**
 * What one row declares about its treatment, or `undefined` for a row declaring none.
 *
 * Over the PROJECTED PAYLOAD rather than over the row, so the caller reads the
 * payload once and both this and the tool's name come out of the same object — the
 * card already holds it, and a second projection per row would walk the same record
 * twice on every frame of a scrolling log.
 */
export function readDeclaredToolKind(
  payload: Readonly<Record<string, unknown>>,
): ToolKindReading | undefined {
  const declared = readWireString(payload[TOOL_KIND_PAYLOAD_KEY]);
  if (declared === undefined) {
    return undefined;
  }
  if (!isToolSubFamily(declared)) {
    return { kind: "unrecognized", declared };
  }
  return {
    kind: "declared",
    subFamily: declared,
    serverLabel: readWireString(payload[TOOL_SERVER_LABEL_PAYLOAD_KEY]),
    argumentSummary: readArgumentSummary(payload[TOOL_ARGUMENT_SUMMARY_PAYLOAD_KEY]),
  };
}

/** Whether a wire string is one of the six. A membership test, never a coercion. */
function isToolSubFamily(candidate: string): candidate is ToolKind {
  return (TOOL_KINDS as readonly string[]).includes(candidate);
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
