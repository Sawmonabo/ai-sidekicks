// Work changing hands, drawn as structure rather than as a message.
//
// `Spec-013 §Timeline Entry Types` makes `handoff` a projection entry with four
// members and the blueprint requires it to be "visually distinct from a message".
// Before this row the feed had no treatment for one, so work changing hands showed as
// an ordinary receipt in the log beside every other row.
//
// FROM AND TO ARE AN ARROW, NOT A SENTENCE. The two actors are rendered as themselves
// with a direction between them; neither is inferred from the row's own actor, and a
// missing one is drawn as an absence. A renderer that filled in `toActor` from the
// row's actor would be asserting who holds the work — which is the one thing a
// handoff row is for.
//
// A HANDOFF WITH NO REASON RENDERS WITHOUT A REASON CLAUSE, verbatim from the
// blueprint, and the same rule governs the channel: an absent optional member draws
// nothing at all rather than an empty slot, because a slot that is sometimes empty
// reads as a value the daemon failed to send.
//
// THE THREAD IS THE ROW'S OWN EDGE. A handoff that names the child run it opened
// carries a thread marker down its leading edge toward that run's chapter; one that
// names none draws no thread. It is a CSS line-grow keyed to the row rather than a
// measured connector between two elements, because the two ends are separately
// virtualized: the chapter header a connector would terminate on may not be mounted,
// and a line drawn to an element that is not there is a line drawn to the wrong place.

import { Glyph, LedgerRow, Nothing, WireFigure } from "../../../primitives/index.js";
import { type ParticipantHueAssignment } from "../../../tokens/index.js";
import { type HandoffEntry } from "./child-run-entries.js";

export interface HandoffRowProps {
  readonly entry: HandoffEntry;
  /** The handing actor's allocated hue, or `undefined` on an unattributed row. */
  readonly participantHue?: ParticipantHueAssignment | undefined;
  /** Whether a rollback later in the log put this row behind it. */
  readonly isSuperseded?: boolean | undefined;
  /**
   * Whether the child run this handoff opened has its chapter in the loaded window.
   *
   * Asked of the caller because only the window knows: the thread is drawn toward a
   * chapter, and a thread toward a chapter that is not loaded would point at nothing.
   */
  readonly hasThreadTarget?: boolean | undefined;
}

/** One handoff, on one line. */
export function HandoffRow(props: HandoffRowProps): React.JSX.Element {
  const { entry } = props;
  const isThreaded = entry.childRunId !== undefined && props.hasThreadTarget === true;
  return (
    <LedgerRow
      participantHueStep={props.participantHue?.step ?? -1}
      {...(props.participantHue === undefined
        ? {}
        : { ringTreatment: props.participantHue.ringTreatment })}
      occurredAtIso={entry.timestamp}
      actorLabel={entry.fromActor ?? "Session"}
      kindLabel={entry.wireType}
      {...(props.isSuperseded === undefined ? {} : { isSuperseded: props.isSuperseded })}
    >
      <p
        className={
          isThreaded
            ? "meridian-handoff-row meridian-handoff-row--threaded"
            : "meridian-handoff-row"
        }
      >
        <Glyph name="agent" title="Handoff" />
        {renderActor(entry.fromActor, "handed by")}
        <Glyph name="chevron-right" title="to" />
        {renderActor(entry.toActor, "handed to")}
        {entry.reason === undefined ? null : (
          <span className="meridian-handoff-row__reason">
            <WireFigure value={entry.reason} />
          </span>
        )}
        {entry.channelId === undefined ? null : (
          <span className="meridian-handoff-row__channel">
            <Glyph name="channel" title="Channel" />
            <WireFigure value={entry.channelId} />
          </span>
        )}
      </p>
    </LedgerRow>
  );
}

/**
 * One side of the handoff, verbatim or as an absence.
 *
 * `empty` and not `not-checked`: the projection produced this entry and left the
 * member out, which is a served reading with nothing in it rather than a question
 * nobody asked.
 */
function renderActor(actorId: string | undefined, role: string): React.JSX.Element {
  if (actorId === undefined) {
    return (
      <Nothing kind="empty" placement="inline" title={`This handoff names no actor ${role}.`} />
    );
  }
  return (
    <span className="meridian-handoff-row__actor">
      <WireFigure value={actorId} />
    </span>
  );
}
