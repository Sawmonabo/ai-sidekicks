// The declared-loss vocabulary: what a transcript operation could not carry, named so a client
// shows the loss rather than a silent gap.
import { z } from "zod";

/**
 * The closed vocabulary of what a transcript operation could not carry. A new kind is a deliberate
 * addition, never a free string. An empty list claims nothing was dropped, so a driver that does
 * not know what it lost may not emit one.
 */
export const DECLARED_LOSS_KINDS = [
  // Non-portable by both vendors' stated rules and never translated. Stripped unconditionally,
  // even on a same-provider replay where signatures would still validate: carrying them would owe
  // an exact reproduction of block order and count, whose failures surface as opaque signature
  // rejections rather than declared losses.
  "provider_private_reasoning",
  // The brief budget evicted older exchanges — whole exchanges only, never halves.
  "context_truncated",
  // An unpaired call took a synthetic error result rather than being dropped.
  "tool_call_history_repaired",
  // The brief floor: verbatim exchanges replaced by a bounded prose rendering.
  "conversation_history_summarized",
  // A logged turn's body could not be read when the fold ran, so the turn is carried with its
  // position and an empty body rather than dropped. Named because the alternatives, a turn that
  // never happened or one whose author said nothing, are both false.
  "turn_content_unavailable",
  // A logged turn's body exceeded the append-time plaintext ceiling and is stored as a
  // codepoint-boundary prefix; the fold carries the prefix and names the loss. Not
  // `context_truncated` (the brief budget evicting whole exchanges) and not
  // `turn_content_unavailable` (which would overstate a turn available as a prefix). Kept in the
  // vocabulary because the brief continuity-marker parser refuses a record carrying a token it
  // cannot place, and the unreadable-record upper bound reports this whole list.
  "turn_content_truncated",
] as const;

/** One member of {@link DECLARED_LOSS_KINDS}. */
export type DeclaredLossKind = (typeof DECLARED_LOSS_KINDS)[number];

/** Validates a {@link DeclaredLossKind}. */
export const DeclaredLossKindSchema: z.ZodType<DeclaredLossKind, DeclaredLossKind> =
  z.enum(DECLARED_LOSS_KINDS);
