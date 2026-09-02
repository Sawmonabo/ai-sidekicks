// The collaboration family's named bounds.
//
// `console/core/constants.ts` holds the substrate's; its own header says each view
// family adds a module beside its subtree rather than widening that one, so a bound
// sits next to the code that spends it. These are that module for channels, the
// roster, and the composing indicators.
//
// Append; never reorder. A number that appears inline in this subtree and is not a
// layout literal belongs here with its rationale.

/**
 * The bootstrap channel's name, as the control plane synthesizes it.
 *
 * The main channel has no row of its own — the channel-list projection composes it
 * from the session's own membership count — so the console recognises it by the one
 * thing the wire carries: this name. Recognising it by position would make the
 * ordering rule depend on the order it is trying to impose.
 */
export const MAIN_CHANNEL_NAME = "main";

/**
 * How long a human's composing indicator survives without a refresh, in
 * milliseconds.
 *
 * The receive half of the bound `Spec-023 §Console Design (Meridian)`'s
 * collaboration section states. It sits well inside the thirty-second Awareness
 * staleness window, so an indicator is gone from the screen long before the
 * protocol would garbage-collect the client that wrote it.
 *
 * The publisher half is deliberately absent: no surface in this console emits a
 * composing signal, because no transport carries one, and a bound spent by nobody
 * is a number that would go stale unread before its first reader arrived. It lands
 * beside the emitter, in the change that adds one.
 */
export const COMPOSING_RECEIVED_STALE_MS = 10_000;

/**
 * Concurrent composers rendered by name before the line folds to a count.
 *
 * Above three the line stops being information and starts being motion: the names
 * churn faster than they can be read, and what a person actually wants from a
 * fourth composer is the fact that the room is busy.
 */
export const COMPOSING_NAMED_CAP = 3;

/**
 * Archived channels rendered inside the disclosure before it scrolls.
 *
 * The disclosure is collapsed by default and archival is terminal, so the list
 * behind it only grows. A cap turns an unbounded region into a bounded one without
 * hiding anything: past it the region scrolls rather than pushing the live channels
 * off the screen.
 */
export const ARCHIVED_CHANNEL_VISIBLE_CAP = 12;
