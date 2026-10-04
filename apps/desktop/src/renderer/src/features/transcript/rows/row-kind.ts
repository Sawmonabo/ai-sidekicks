// Which kind of card a row is, decided once. Icon, label and layout all come from this one
// table, so they cannot drift apart. The classifier reads only the row's `type`, never the tool
// name: the wire declares no tool kind, and inferring one would assert a fact the daemon never
// sent. Inline cards (diff, attachment, artifact) are not row kinds; `MessageRow` renders them.

import type { HydratedSessionEventContent } from "@ai-sidekicks/contracts/event-envelope";
import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";

import type { GlyphName } from "@renderer/styles/glyphs.js";

/**
 * Every kind of card a transcript row can take. Closed.
 *
 * The union derives from the tuple so a kind cannot be added to one without the other.
 */
export const TRANSCRIPT_ROW_KINDS = [
  "user-message",
  "agent-message",
  "thinking",
  "tool-call",
] as const;

/** One row kind. Derived from the enumeration, never restated. */
export type TranscriptRowKind = (typeof TRANSCRIPT_ROW_KINDS)[number];

/**
 * How much of a row kind's card is open before anybody touches it: tool rows render as one
 * line until opened, and message bodies open.
 */
export const ROW_LAYOUTS = ["body-open", "one-line"] as const;

/** One card layout. Derived from the enumeration, never restated. */
export type RowLayout = (typeof ROW_LAYOUTS)[number];

/** What one row kind supplies: the icon, the label, and the layout. */
export interface RowKindDescriptor {
  readonly kind: TranscriptRowKind;
  /** The row kind's icon, or `undefined` where the row carries no mark (the user's message). */
  readonly glyph: GlyphName | undefined;
  /** The row kind's name, for the kind label when the row carries no wire-true label. */
  readonly label: string;
  readonly layout: RowLayout;
}

/** A row kind's descriptor, with the icon typed present for every kind but the user's message. */
type DescriptorOf<TKind extends TranscriptRowKind> = RowKindDescriptor & {
  readonly kind: TKind;
  readonly glyph: TKind extends "user-message" ? undefined : GlyphName;
};

/** Total over `TranscriptRowKind` by construction: a new kind fails to compile until described. */
const DESCRIPTORS_BY_ROW_KIND: { readonly [TKind in TranscriptRowKind]: DescriptorOf<TKind> } = {
  "user-message": {
    kind: "user-message",
    glyph: undefined,
    label: "Message",
    layout: "body-open",
  },
  "agent-message": {
    kind: "agent-message",
    glyph: "agent",
    label: "Reply",
    layout: "body-open",
  },
  thinking: {
    kind: "thinking",
    glyph: "dot",
    label: "Reasoning",
    layout: "body-open",
  },
  "tool-call": {
    kind: "tool-call",
    glyph: "run",
    label: "Tool",
    layout: "one-line",
  },
};

/**
 * Which row kind each body-bearing event type takes.
 *
 * Keyed by exact type, not prefix: a prefix would silently absorb a later `tool.*` type nobody
 * has looked at.
 */
const ROW_KIND_BY_EVENT_TYPE: ReadonlyMap<string, TranscriptRowKind> = new Map([
  ["user.message", "user-message"],
  ["assistant.message", "agent-message"],
  ["assistant.thinking_update", "thinking"],
  ["tool.invoked", "tool-call"],
  ["tool.result", "tool-call"],
  ["tool.error", "tool-call"],
] satisfies readonly (readonly [string, TranscriptRowKind])[]);

/**
 * The kind this row belongs to, or `undefined` for a type this table does not name.
 *
 * `undefined` is the ordinary case: only six event types carry a body a transcript card draws.
 */
export function classifyTranscriptRow(row: TranscriptEventRow): RowKindDescriptor | undefined {
  const kind = ROW_KIND_BY_EVENT_TYPE.get(row.type);
  return kind === undefined ? undefined : DESCRIPTORS_BY_ROW_KIND[kind];
}

/** The descriptor for a row kind named directly, for a caller that already has one. */
export function describeRowKind<TKind extends TranscriptRowKind>(kind: TKind): DescriptorOf<TKind> {
  return DESCRIPTORS_BY_ROW_KIND[kind];
}

/**
 * The states a tool row reports. Closed; the enumeration lives beside the function that decides
 * between them.
 */
export const TOOL_RESULT_STATES = [
  "running",
  "ok",
  "error",
  "truncated",
  "body-unavailable",
] as const;

/** One tool result state. Derived from the enumeration, never restated. */
export type ToolResultState = (typeof TOOL_RESULT_STATES)[number];

/**
 * What a tool row's header reports, from its event type and its hydrated body.
 *
 * `tool.error` outranks every body condition: a collapsed row must not hide a failure, and a
 * truncated error is still an error. Below that the body's condition decides, because a body
 * that could not be read is not the same fact as a result that succeeded.
 */
export function toolResultState(
  eventType: string,
  content: HydratedSessionEventContent | undefined,
): ToolResultState {
  if (eventType === "tool.error") {
    return "error";
  }
  if (eventType === "tool.invoked") {
    return "running";
  }
  if (content === undefined) {
    return "ok";
  }
  if (content.status === "unavailable") {
    return "body-unavailable";
  }
  return content.contentTruncated === true ? "truncated" : "ok";
}
