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
// that temptation, and it is `Spec-023 §Rules every console surface obeys`' fail-closed
// projection ("An unknown enum member renders as the explicit unrecognized row or badge,
// never as a guess") reached from the other side. The design's tool families (command output, file edits, read folds,
// MCP tool cards, web-search results, image results) are real distinctions and the
// wire declares none of them: `ToolActivityPayload` carries `toolName`, `toolCallId`,
// and `durationMs`, and no member says what KIND of tool ran. Reading the family out
// of the name would be the console asserting a fact the daemon never sent, which is
// the failure the wire-truth rule names. So every tool row takes the tool layout, the
// name renders wire-verbatim in mono, and the sub-family arrives when a wire member
// declares it.
//
// THE INLINE CARDS ARE NOT A FAMILY HERE. A diff, an attachment, and an artifact are
// bodies the repos family owns behind `InlineCardSeatProps`, and a row carries one
// where its own content says so — which is a question about a row's attachments, not
// about which card it is. `MessageCard` renders the seat; this table does not know it
// exists.

import type { HydratedSessionEventContent, TimelineRow } from "@ai-sidekicks/contracts";

import type { GlyphName } from "../../tokens/index.js";

/**
 * Every card family a ledger row can take. Closed.
 *
 * The tuple is the declaration and the union is derived from it, for the reason
 * `primitives/Chip.tsx` gives about its own tone set: a sixth family added to a
 * hand-written union while the table below stayed at five would render a row through
 * a descriptor that does not exist.
 */
export const CARD_FAMILIES = [
  "participant-message",
  "assistant-message",
  "assistant-reasoning",
  "tool-activity",
  "receipt",
] as const;

/** One card family. Derived from the enumeration, never restated. */
export type CardFamily = (typeof CARD_FAMILIES)[number];

/**
 * How much of a family's card is open before anybody touches it.
 *
 * `Spec-023 §Meridian, the design language` rule 7: "Tool rows render as one line until
 * opened." The other two are this console's own reading of the same density budget —
 * message bodies open, receipts one line — stated here as a value.
 */
export const CARD_LAYOUTS = ["body-open", "one-line"] as const;

/** One card layout. Derived from the enumeration, never restated. */
export type CardLayout = (typeof CARD_LAYOUTS)[number];

/** What one family supplies: the icon, the label, and the layout. */
export interface CardFamilyDescriptor {
  readonly family: CardFamily;
  readonly glyph: GlyphName;
  /**
   * The family's name in the console's own words, for the row's kind slot when the
   * row carries no wire-true label of its own. Sentence case, no exclamation.
   */
  readonly label: string;
  readonly layout: CardLayout;
}

/**
 * Total over `CardFamily` by construction — a sixth family fails to compile here
 * before it can reach a card that renders it without an icon.
 */
const CARD_FAMILY_DESCRIPTORS: Readonly<Record<CardFamily, CardFamilyDescriptor>> = {
  "participant-message": {
    family: "participant-message",
    glyph: "member",
    label: "Message",
    layout: "body-open",
  },
  "assistant-message": {
    family: "assistant-message",
    glyph: "agent",
    label: "Reply",
    layout: "body-open",
  },
  "assistant-reasoning": {
    family: "assistant-reasoning",
    glyph: "dot",
    label: "Reasoning",
    layout: "body-open",
  },
  "tool-activity": {
    family: "tool-activity",
    glyph: "run",
    label: "Tool",
    layout: "one-line",
  },
  receipt: {
    family: "receipt",
    glyph: "check",
    label: "Receipt",
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
const FAMILY_BY_EVENT_TYPE: ReadonlyMap<string, CardFamily> = new Map([
  ["user.message", "participant-message"],
  ["assistant.message", "assistant-message"],
  ["assistant.thinking_update", "assistant-reasoning"],
  ["tool.invoked", "tool-activity"],
  ["tool.result", "tool-activity"],
  ["tool.error", "tool-activity"],
] satisfies readonly (readonly [string, CardFamily])[]);

/**
 * The family this row belongs to.
 *
 * A row whose type this table does not name is a `receipt` — one line stating what
 * happened, drawn from the row's own wire summary. That is deliberately not an error
 * and deliberately not a guess: the taxonomy has 159 types and five of them carry a
 * machine-authored body, so "this row has no body to open" is the ordinary case and
 * a card family for it is what keeps the log complete.
 */
export function classifyCardFamily(row: TimelineRow): CardFamilyDescriptor {
  const family = FAMILY_BY_EVENT_TYPE.get(row.type) ?? "receipt";
  return CARD_FAMILY_DESCRIPTORS[family];
}

/** The descriptor for a family named directly, for a caller that already has one. */
export function cardFamilyDescriptor(family: CardFamily): CardFamilyDescriptor {
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
 * `Spec-023 §Meridian, the design language` rule 3 makes red the console's one word for
 * "something failed" and a failure a reader has to open a row to find was never said.
 * A truncated error is still an error. Below that the body's own condition decides,
 * because a result whose body could not be read is not the same fact as a result that
 * succeeded — rule 8's five kinds of nothing, where "a renderer that collapses two of
 * these into one is wrong".
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
