// Why this pane refuses, and the constructors that say so.
//
// `persistence/refusals.ts`'s arrangement, one family over: the closed refusal
// vocabulary is declared in a module of its own, below every module that raises one.
// Three of this pane's modules construct a refusal — the reader on a rejected call,
// the acts on a second manifest read, the payload fetch on a second fetch — and the
// reading they are recorded on is a fourth. A vocabulary that lived beside any one of
// those would make a producer import its sibling to name a code.
//
// ONE DECLARATION OF THE CLOSED SET, `as const`, with the union derived from it. The
// prose this replaces said "the three codes this pane mints" with four constants under
// it: a count in a sentence is not something a fifth code can fail against.

import {
  normalizeWireRejection,
  refuse,
  type ConsoleRefusal,
  type WireRefusal,
} from "../../core/index.js";

/**
 * Which subsystem refused, when the refusal is the pane's own and not the port's.
 *
 * `core/refusal.ts` gives `origin` as the field that lets a refusal surfacing three
 * layers from where it was raised still name its author. Written once here rather than
 * spelled at each construction site, and read by `artifact-pane-reading.ts` too, whose
 * unreadable-reply arm is the fourth site that mints one.
 *
 * The suites that assert an `artifact-pane-reader` origin spell the string rather than
 * importing this, which is what an assertion about a value has to do: a test that
 * imported the constant it asserts would pass whatever that constant became.
 */
export const ARTIFACT_READER_REFUSAL_ORIGIN = "artifact-pane-reader";

/**
 * The codes this pane mints. The port owns every other refusal the pane renders.
 *
 * ONE ARRAY AND NO COUNT IN PROSE — the shape `repos/proposals/prepared-proposal.ts`
 * and `persistence/refusals.ts` already keep, and the reason is this set's own
 * history: the sentence here read "the three codes this pane mints" with four
 * constants under it, so a reader was told a number the code contradicted and nothing
 * could fail. Membership is stated once now, and counted by reading it.
 *
 * Declared here, beside the reading they are recorded on, rather than in either of the
 * two modules that raise them: a refusal vocabulary split across the reader and the
 * acts would be two closed sets for one pane, and a caller narrowing on a code would
 * have to know which half minted it.
 *
 * The four one-constant-per-code bindings this replaces were all exported and imported
 * nowhere. `knip`'s `ignoreExportsUsedInFile` makes an export whose only reader is its
 * own file invisible to the dead-code gate, so the four sat on unread surface with no
 * gate able to say so. Each literal is written at the single site that mints it now,
 * `satisfies`-checked against the union below for `palette/keybindings.ts`'s stated
 * reason: without the check the closed vocabulary binds nothing, and dropping a member
 * from it would break no code at all.
 */
export const ARTIFACT_PANE_REFUSAL_CODES = [
  "read-threw",
  "payload-fetch-in-flight",
  "manifest-read-in-flight",
  "reply-unreadable",
] as const;

/** One code this pane mints. Derived, so the vocabulary is declared exactly once. */
export type ArtifactPaneRefusalCode = (typeof ARTIFACT_PANE_REFUSAL_CODES)[number];

/**
 * The refusal a read that threw becomes.
 *
 * A thrown value is not a refusal until something makes it one, and the alternative —
 * letting it reject inside a timer callback — leaves the pane on the in-flight absence
 * for the rest of its life.
 *
 * A DELEGATION, NOT A NORMALIZER, on `repos/repo-reads.ts:repoCallRefusal`'s shape.
 * The three-arm reading this replaces flattened everything to one code and one
 * sentence: a JSON-RPC envelope carrying `data.type` arrived as `read-threw` with the
 * daemon's dotted code and its own words discarded, a rate-limit envelope lost its
 * retry hint, a `ConsoleRefusal` thrown across the bridge lost the origin its author
 * named, and `error instanceof Error` answered false for an `Error` minted in the
 * preload realm — which is the realm every bridge rejection crosses — so that value
 * took the not-an-error arm and its message went with it. `core/wire-rejection.ts`
 * owns all four of those readings and a terminal that never throws, and the two
 * things left here are this pane's own: the origin, and the sentence for a rejection
 * that said nothing machine-readable.
 *
 * THE REJECTED VALUE IS NOT QUOTED INTO THE SENTENCE. It names the leg and stops
 * there — a rejection off the wire can carry participant content as readily as a
 * schema failure can, which is the rule `Spec-023 §Console Design (Meridian)` rule 9
 * sets and which the copy this replaces broke by interpolating the message into it.
 *
 * THE RETURN TYPE IS THE NORMALIZER'S OWN. `WireRefusal` is a `ConsoleRefusal`
 * widened by the optional retry hint a rate-limit envelope registers, so every
 * consumer that takes a refusal takes this unchanged — and narrowing it back to
 * `ConsoleRefusal` here would hide the one member this delegation exists to stop
 * dropping from the only reader that could offer the retry.
 */
export function readFailureRefusal(error: unknown): WireRefusal {
  return normalizeWireRejection(ARTIFACT_READER_REFUSAL_ORIGIN, error, {
    code: "read-threw" satisfies ArtifactPaneRefusalCode,
    detail: "The artifact read failed before it could answer.",
  });
}

/**
 * The refusal a second payload fetch becomes while the first is still on the wire.
 *
 * NAMED RATHER THAN SILENT, and it names the artifact the pane is actually waiting
 * on rather than the one that was pressed: a participant told "something is in
 * flight" cannot tell what. The control that produced it is held while a fetch is
 * pending, so this is structurally unreachable from the pane — and recorded anyway,
 * for `repos/proposals/proposal-gate-actions.ts`'s reason: a press that produced nothing at all
 * is the silent no-op rule 8 forbids.
 */
export function payloadFetchInFlightRefusal(pendingArtifactId: string): ConsoleRefusal {
  return refuse(
    ARTIFACT_READER_REFUSAL_ORIGIN,
    "payload-fetch-in-flight" satisfies ArtifactPaneRefusalCode,
    `The payload of ${pendingArtifactId} has been asked for and the daemon has not answered yet. Nothing else is fetched until it settles.`,
  );
}

/**
 * The refusal a second manifest re-read becomes while this row's first is on the wire.
 *
 * NAMED RATHER THAN SILENT, on `payloadFetchInFlightRefusal`'s reason, and it names the
 * ROW: two presses on one row are two reads of one manifest whose answers can settle in
 * either order, so the older reply would put the staler row back. The control that
 * produced it is held while that row's read is pending, so this is structurally
 * unreachable from the panel — and recorded anyway, because a press that produced
 * nothing at all is the silent no-op rule 8 forbids.
 */
export function manifestReadInFlightRefusal(artifactId: string): ConsoleRefusal {
  return refuse(
    ARTIFACT_READER_REFUSAL_ORIGIN,
    "manifest-read-in-flight" satisfies ArtifactPaneRefusalCode,
    `The manifest of ${artifactId} has been asked for again and the daemon has not answered yet. That row is read once until it settles.`,
  );
}
