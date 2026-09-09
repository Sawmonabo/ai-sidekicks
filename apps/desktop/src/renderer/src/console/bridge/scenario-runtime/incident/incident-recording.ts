// An incident recording: wire frames held as text, replayed through the real decode.
//
// `Spec-023 §Console Design (Meridian)` §The fixture bridge names an `incident` class of
// scenario "carrying byte-faithful wire deltas for replay of recorded defects". It is
// the one mechanism the design gives for turning a defect that happened into a
// regression the console cannot lose, and the reason it has to be TEXT rather than a
// hand-written script is the defect class it exists for.
//
// A family scenario is authored in `ConsoleSessionEvent`s and composed onto the wire by
// `scenario-envelope.ts`. That is the readable way to write a session, and it is exactly
// what cannot reproduce a decode defect: an authored beat is written against the
// console's own reading of the wire, so a console that reads the wire wrongly composes
// frames that agree with it and every fixture run passes while every real session fails.
// `scenario-envelope.ts`'s header records that happening. A recording is the other
// direction — frame text that no console code composed, replayed through the same
// decode boundary a live delivery crosses — so a console that no longer reads those
// bytes fails on them.
//
// WHAT IS CLAIMED, STATED NARROWLY SO IT CAN BE TRUE. A recording holds each frame as
// TEXT, and the player parses that text and never recomposes a frame from a typed value.
// PROVENANCE IS NOT CLAIMED: the deltas in this tree are hand-authored, and nothing here
// captures a live delivery — the console's preload bridge hands its subscribers parsed
// values rather than frames, so no recorder inside the renderer could be fed by the one
// process that sees them. What survives, and is the half that catches the defect class,
// is that the text is the authority: nothing between a delta and the decode boundary
// re-derives a member, and an edit to a frame's text is an edit to what the replay
// delivers.
//
// WHAT IS NOT HERE. Replay, which is `incident-replay.ts`: what a recording IS and what
// reading one back does are two jobs, and the reader has to reach the console's own
// decode boundary while these declarations reach nothing at all.

/**
 * One recorded frame: the tick it arrived at, and its text.
 *
 * `atMs` is measured from the recording's own start, the same origin a
 * {@link ScenarioBeat} measures from, so a replay needs no rebasing arithmetic.
 */
export interface IncidentWireDelta {
  readonly atMs: number;
  /** The frame's text, verbatim. Parsed on replay and never re-serialized. */
  readonly frameJson: string;
}

/** A recorded defect: what it was, when it was taken, and the frames it arrived on. */
export interface IncidentRecording {
  /** Stable handle for this defect. Names the incident, never the surface it broke. */
  readonly incidentId: string;
  /** What went wrong, in the words the person replaying it needs. */
  readonly summary: string;
  readonly recordedAtIso: string;
  readonly deltas: readonly IncidentWireDelta[];
}
