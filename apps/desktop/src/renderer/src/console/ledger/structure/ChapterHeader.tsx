// The chapter header — one finished run, folded to a line somebody can open.
//
// WHAT WAS MISSING. `chapters.ts` was written to be drawn: it carries the actor, the
// lifecycle, which terminal ended the run, the row count, the clipped count and the
// incomplete-child marker, and `ChapterCollapseState` carries whether a person has
// opened one. None of it reached a component. What reached the rows instead was a
// flat `collapsedRowIds` set handed down as a per-row density — which exactly one
// card reads. So a completed or failed run stayed fully expanded, and the palette's
// collapse row refused on the reasoning that everything was already folded.
//
// THE HEADER IS THE CHAPTER'S ONLY CONTROL. It is a disclosure and nothing else: it
// opens the fold and folds it back, and every other decision about the chapter —
// which rows are in it, whether it has ended, what ended it — is the model's. That
// is why nothing here re-derives a lifecycle or a count; a header that recomputed
// either would be a second answer to a question the fold already settled.
//
// WHAT IT SAYS, and every one of them is a value rather than a phrase: the actor
// verbatim in their own hue, the terminal event type verbatim in mono, how many rows
// the chapter holds, how many of them the body clips, and whether a child run this
// chapter summarizes expanded incompletely.

import { Glyph, Nothing } from "../../primitives/index.js";
import {
  PARTICIPANT_HUE_STEPS,
  participantHueTokenName,
  tokenReference,
  type ParticipantHueAssignment,
} from "../../tokens/index.js";
import { type LedgerChapter } from "./chapters.js";

export interface ChapterHeaderProps {
  readonly chapter: LedgerChapter;
  /** Whether the chapter's rows are on screen beneath this header. */
  readonly isOpen: boolean;
  /** The actor's allocated hue, or `undefined` where the wheel never admitted them. */
  readonly participantHue?: ParticipantHueAssignment | undefined;
  readonly onToggle: (chapter: LedgerChapter) => void;
}

/** One run's chapter, as a header. */
export function ChapterHeader(props: ChapterHeaderProps): React.JSX.Element {
  const { chapter } = props;
  const hueStep = props.participantHue?.step ?? -1;
  return (
    <div
      className="meridian-chapter-header"
      style={
        hueStep < 0 || hueStep >= PARTICIPANT_HUE_STEPS
          ? undefined
          : {
              // The same 2 px attribution edge every ledger row wears, so a chapter
              // and the rows inside it are attributed the same way and by the same
              // wheel. Rule 3 keeps the hue off text, so it is an edge and not a tint.
              borderInlineStartColor: tokenReference(participantHueTokenName(hueStep)),
            }
      }
    >
      <button
        type="button"
        className="meridian-chapter-header__disclosure"
        aria-expanded={props.isOpen}
        onClick={() => {
          props.onToggle(chapter);
        }}
      >
        <Glyph name={props.isOpen ? "chevron-down" : "chevron-right"} />
        {props.isOpen ? "Fold" : "Open"}
      </button>
      {chapter.actorId === undefined ? (
        <Nothing kind="empty" placement="inline" title="No row named an actor." />
      ) : (
        <span className="meridian-chapter-header__actor">{chapter.actorId}</span>
      )}
      {/* The daemon's own word for how the run ended, in mono and verbatim. The
          console never paraphrases it into a past tense of its own. */}
      {chapter.terminalEventType === undefined ? null : (
        <span className="meridian-chapter-header__terminal">{chapter.terminalEventType}</span>
      )}
      <span className="meridian-chapter-header__counts">
        <span className="meridian-chapter-header__figure">{String(chapter.rowCount)}</span>
        {chapter.rowCount === 1 ? " entry" : " entries"}
        {chapter.clippedRowCount === 0 ? null : (
          <>
            {", "}
            <span className="meridian-chapter-header__figure">
              {String(chapter.clippedRowCount)}
            </span>
            {" clipped"}
          </>
        )}
      </span>
      {chapter.hasIncompleteChildExpand ? (
        <Nothing
          kind="not-loaded"
          placement="inline"
          title="A child run in this chapter is not fully expanded."
        />
      ) : null}
    </div>
  );
}
