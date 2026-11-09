// Which kind of card a row is, decided once. Icon and label both come from this one table, so
// they cannot drift apart. The classifier reads only the row's `type`, never the tool name: the
// wire declares no tool kind, and inferring one would assert a fact the daemon never sent.
// Inline cards (diff, attachment, artifact) are not row kinds; `MessageRow` renders them.

import { CONTENT_LENGTH_PAYLOAD_KEY } from "@ai-sidekicks/contracts/event/declared-variants";
import type { SessionEventType } from "@ai-sidekicks/contracts/event/registry";
import { TOOL_CALL_OPENING_EVENT_TYPE } from "@ai-sidekicks/contracts/transcript/row";
import { USER_MESSAGE_EVENT_TYPE } from "@ai-sidekicks/contracts/transcript/operations";

import { projectedPayload, readWireCount } from "#renderer/store/session/events/wire-payload.js";
import type { GlyphName } from "#renderer/styles/glyphs.js";
import {
  type ProjectedTranscriptRow,
  type ProjectedRowContent,
} from "#renderer/store/session/entities/vocabulary.js";

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

/** What one row kind supplies: the icon and the label. */
export interface RowKindDescriptor {
  readonly kind: TranscriptRowKind;
  /** The row kind's icon, or `undefined` where the row carries no mark (the user's message). */
  readonly glyph: GlyphName | undefined;
  /** The row kind's name, for the kind label when the row carries no wire-true label. */
  readonly label: string;
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
  },
  "agent-message": {
    kind: "agent-message",
    glyph: "agent",
    label: "Reply",
  },
  thinking: {
    kind: "thinking",
    glyph: "dot",
    label: "Reasoning",
  },
  "tool-call": {
    kind: "tool-call",
    glyph: "run",
    label: "Tool",
  },
};

/**
 * Which row kind each body-bearing event type takes.
 *
 * Keyed by exact type, not prefix: a prefix would silently absorb a later `agent.toolCall.*` type
 * nobody has looked at.
 */
/** The type of the event a failed tool call ends in. */
const TOOL_CALL_FAILED_EVENT_TYPE = "agent.toolCall.failed" satisfies SessionEventType;

const ROW_KIND_BY_EVENT_TYPE: ReadonlyMap<string, TranscriptRowKind> = new Map([
  [USER_MESSAGE_EVENT_TYPE, "user-message"],
  ["agent.message.sent", "agent-message"],
  ["agent.thinking.updated", "thinking"],
  [TOOL_CALL_OPENING_EVENT_TYPE, "tool-call"],
  ["agent.toolCall.completed", "tool-call"],
  [TOOL_CALL_FAILED_EVENT_TYPE, "tool-call"],
] satisfies readonly (readonly [SessionEventType, TranscriptRowKind])[]);

/**
 * The kind this row belongs to, or `undefined` for a type this table does not name.
 *
 * `undefined` is the ordinary case: only six event types carry a body a transcript card draws.
 */
export function classifyTranscriptRow(row: ProjectedTranscriptRow): RowKindDescriptor | undefined {
  const kind = ROW_KIND_BY_EVENT_TYPE.get(row.type);
  return kind === undefined ? undefined : DESCRIPTORS_BY_ROW_KIND[kind];
}

/** The descriptor for a row kind named directly, for a caller that already has one. */
export function describeRowKind<TKind extends TranscriptRowKind>(kind: TKind): DescriptorOf<TKind> {
  return DESCRIPTORS_BY_ROW_KIND[kind];
}

/**
 * Whether a row is a call with a body under it, so it folds on its own row: a tool row whose
 * payload counts a body, or whose output is streaming in now. A call with neither draws no
 * chevron, because nothing would open.
 */
export function isFoldableCall(row: ProjectedTranscriptRow, hasLiveText: boolean): boolean {
  if (classifyTranscriptRow(row)?.kind !== "tool-call") {
    return false;
  }
  return hasLiveText || (readWireCount(projectedPayload(row), CONTENT_LENGTH_PAYLOAD_KEY) ?? 0) > 0;
}

/**
 * The states a tool row reports. Closed; the enumeration lives beside the function that decides
 * between them.
 */
export const TOOL_RESULT_STATES = ["running", "ok", "error", "body-unavailable"] as const;

/** One tool result state. Derived from the enumeration, never restated. */
export type ToolResultState = (typeof TOOL_RESULT_STATES)[number];

/**
 * What a tool row's header reports, from its event type and the body its row carries.
 *
 * A failed call outranks every body condition: a collapsed row must not hide a failure. Below
 * that the body's condition decides, because a body that could not be read is not the same fact as
 * a result that succeeded.
 */
export function toolResultState(
  eventType: string,
  content: ProjectedRowContent | undefined,
): ToolResultState {
  if (eventType === TOOL_CALL_FAILED_EVENT_TYPE) {
    return "error";
  }
  if (eventType === TOOL_CALL_OPENING_EVENT_TYPE) {
    return "running";
  }
  return content?.status === "unavailable" ? "body-unavailable" : "ok";
}
