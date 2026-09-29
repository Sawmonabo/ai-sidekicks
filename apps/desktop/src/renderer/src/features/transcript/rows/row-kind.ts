// The one classifier — which card family a row is, decided once.
//
// THIS CONSOLE'S OWN RULE, because no committed document states it: each message and
// tool activity renders as a card whose family is decided once, by one classifier
// feeding icon, label, and layout. One function, one table, and the three things a card renders with come out
// of it together. A second `if (row.type === …)` anywhere under `cards/` is the drift
// this module exists to prevent: the glyph would agree with the layout until somebody
// added a family to one of them.
//
// WHAT THE CLASSIFIER IS ALLOWED TO READ. The row's `type`, which is a registered
// `SessionEventType`, and nothing else. Not the actor, not the summary, and above all
// not the tool NAME — never inventing a tool family is a rule about exactly
// that temptation, and it is the fail-closed projection rule — an unknown enum member
// renders as the explicit unrecognized row or badge, never as a guess — reached from the
// other side. The tool families (command output, file edits, read folds,
// MCP tool cards, web-search results, image results) are real distinctions and the
// wire declares none of them: `ToolActivityPayload` carries `toolName`, `toolCallId`,
// and `durationMs`, and no member says what KIND of tool ran. Reading the family out
// of the name would be the console asserting a fact the daemon never sent, which is
// the failure the wire-truth rule names. So every tool row takes the tool layout, the
// name renders wire-verbatim in mono, and the sub-family arrives when a wire member
// declares it.
//
// THE INLINE CARDS ARE NOT A FAMILY HERE. A diff, an attachment, and an artifact are
// bodies the repos family owns behind `InlineCardProps`, and a row carries one
// where its own content says so — which is a question about a row's attachments, not
// about which card it is. `MessageRow` renders the seat; this table does not know it
// exists.

import type { HydratedSessionEventContent, TimelineRow } from "@ai-sidekicks/contracts";

import type { GlyphName } from "@renderer/styles/glyphs.js";

/**
 * Every card family a ledger row can take. Closed.
 *
 * The tuple is the declaration and the union is derived from it, for the reason
 * `primitives/figures/Chip.tsx` gives about its own tone set: a fifth kind added to a
 * hand-written union while the table below stayed at four would render a row through
 * a descriptor that does not exist.
 */
export const TRANSCRIPT_ROW_KINDS = [
  "user-message",
  "agent-message",
  "thinking",
  "tool-call",
] as const;

/** One card family. Derived from the enumeration, never restated. */
export type TranscriptRowKind = (typeof TRANSCRIPT_ROW_KINDS)[number];

/**
 * How much of a family's card is open before anybody touches it.
 *
 * Tool rows render as one line until opened, and message bodies open: this app's own
 * reading of the density budget, stated here as a value.
 */
export const ROW_LAYOUTS = ["body-open", "one-line"] as const;

/** One card layout. Derived from the enumeration, never restated. */
export type RowLayout = (typeof ROW_LAYOUTS)[number];

/** What one family supplies: the icon, the label, and the layout. */
export interface RowKindDescriptor {
  readonly kind: TranscriptRowKind;
  /** The family's icon, or `undefined` where the row carries no mark (the person's own message). */
  readonly glyph: GlyphName | undefined;
  /**
   * The family's name in the console's own words, for the row's kind slot when the
   * row carries no wire-true label of its own. Sentence case, no exclamation.
   */
  readonly label: string;
  readonly layout: RowLayout;
}

/**
 * One family's descriptor, with the icon typed present for every family but the
 * person's own message, so a caller naming one of those reads it without a check.
 */
type DescriptorOf<TFamily extends TranscriptRowKind> = RowKindDescriptor & {
  readonly kind: TFamily;
  readonly glyph: TFamily extends "user-message" ? undefined : GlyphName;
};

/**
 * Total over `TranscriptRowKind` by construction — a fifth kind fails to compile here
 * before it can reach a card that renders it without an icon.
 */
const CARD_FAMILY_DESCRIPTORS: { readonly [TFamily in TranscriptRowKind]: DescriptorOf<TFamily> } =
  {
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
 * Which family each body-bearing event type takes.
 *
 * Keyed by the registered `SessionEventType` literals rather than by a prefix match:
 * a prefix would silently absorb a later `tool.*` type nobody has looked at, and the
 * fall-through below is the honest answer for a type this table has not been taught.
 */
const FAMILY_BY_EVENT_TYPE: ReadonlyMap<string, TranscriptRowKind> = new Map([
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
 * `undefined` is deliberately not an error and deliberately not a guess: the taxonomy has
 * 159 types and six of them carry a body this seat draws, so "this row has no body here"
 * is the ordinary case, and the rows a person reads among the rest (the system messages)
 * are drawn before the seat is asked.
 */
export function classifyTranscriptRow(row: TimelineRow): RowKindDescriptor | undefined {
  const kind = FAMILY_BY_EVENT_TYPE.get(row.type);
  return kind === undefined ? undefined : CARD_FAMILY_DESCRIPTORS[kind];
}

/** The descriptor for a family named directly, for a caller that already has one. */
export function describeRowKind<TFamily extends TranscriptRowKind>(
  family: TFamily,
): DescriptorOf<TFamily> {
  return CARD_FAMILY_DESCRIPTORS[family];
}

/**
 * The five states a tool row reports. Closed, and this console's own set: Running · Ok ·
 * Error (`tool.error`) · Truncated · Body unavailable. No committed document enumerates
 * them, so the enumeration lives here, beside the function that decides between them.
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
 * TWO SOURCES, RANKED, AND THE RANKING IS THE POLICY. `tool.error` outranks every
 * body condition: a collapsed row may not hide a tool error from the header, because
 * red is the console's one word for "something failed" and a failure a reader has to
 * open a row to find was never said. A truncated error is still an error. Below that the
 * body's own condition decides, because a result whose body could not be read is not the
 * same fact as a result that succeeded — there are five kinds of nothing, and a renderer
 * that collapses two of them into one is wrong.
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
