// The tool kind vocabulary and the reader over a row's own payload.
// `ToolActivityPayload` carries no member saying what kind of tool ran, so the kind is never
// inferred from `toolName`. The reader is fail-closed both ways: an absent declaration reads as
// no tool kind, and an unrecognized one reads as unrecognized rather than as absent.

import { readWireString } from "#renderer/lib/wire/strings.js";

/** The six tool treatments. Closed; the union derives from the tuple. */
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
 * The payload member that would declare a row's tool kind. No registered payload carries it, so
 * the reader answers `undefined` for a row of any registered payload.
 */
export const TOOL_KIND_PAYLOAD_KEY = "toolKind";

/** The member carrying an MCP call's server label. */
export const TOOL_SERVER_LABEL_PAYLOAD_KEY = "mcpServerLabel";

/** The member carrying the call's typed argument summary. */
export const TOOL_ARGUMENT_SUMMARY_PAYLOAD_KEY = "toolArgumentSummary";

/** What one row declares about its own treatment. Two arms and no third. */
export type ToolKindReading =
  | {
      readonly kind: "declared";
      readonly toolKind: ToolKind;
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

/**
 * What one row declares about its treatment, or `undefined` for a row declaring none.
 *
 * Takes the already-projected payload so the card reads it once for both this and the name.
 */
export function readDeclaredToolKind(
  payload: Readonly<Record<string, unknown>>,
): ToolKindReading | undefined {
  const declared = readWireString(payload[TOOL_KIND_PAYLOAD_KEY]);
  if (declared === undefined) {
    return undefined;
  }
  if (!isToolKind(declared)) {
    return { kind: "unrecognized", declared };
  }
  return {
    kind: "declared",
    toolKind: declared,
    serverLabel: readWireString(payload[TOOL_SERVER_LABEL_PAYLOAD_KEY]),
    argumentSummary: readArgumentSummary(payload[TOOL_ARGUMENT_SUMMARY_PAYLOAD_KEY]),
  };
}

/** Whether a wire string is one of the six. A membership test, never a coercion. */
function isToolKind(candidate: string): candidate is ToolKind {
  return (TOOL_KINDS as readonly string[]).includes(candidate);
}

/**
 * The argument summary the wire supplied, as strings.
 *
 * A non-string element is dropped, not stringified: `String({})` would put `[object Object]`
 * on the page as though the daemon had sent it.
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
