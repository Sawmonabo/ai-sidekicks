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
// verbatim in their own hue, the run's newest state verbatim in mono, the account the
// run is billed to, how many rows the chapter holds, how many of them the body clips,
// and whether a child run this chapter summarizes expanded incompletely.
//
// THE STATE REPLACED THE TERMINAL RATHER THAN JOINING IT. The header used to draw
// `terminalEventType`, which is empty for every run that has not ended — so a live
// chapter said who and how many and nothing at all about what the run was doing. The
// state is the wider fact and a terminal is one of its values, so drawing both would
// put the same word on the line twice on every finished run.
//
// AND THE CLIPPED ROWS BECAME REACHABLE. The clipped figure named rows that were
// dropped out of the feed, which made it a count of something a person could not get
// to. `ChapterBodyViewport` is where they live now, mounted under this line while the
// chapter is open.

import { Glyph, Nothing } from "../../../primitives/index.js";
import { ChapterBodyViewport } from "./ChapterBodyViewport.js";
import {
  PARTICIPANT_HUE_STEPS,
  participantHueTokenName,
  tokenReference,
  type ParticipantHueAssignment,
} from "../../../tokens/index.js";
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
      {/* The daemon's own word for what the run is doing, in mono and verbatim. The
          console never paraphrases it into a tense of its own, and says nothing at all
          where the log has reported no state since the last rewind. */}
      {chapter.runStateEventType === undefined ? null : (
        <span className="meridian-chapter-header__state">{chapter.runStateEventType}</span>
      )}
      {/* The account the run was admitted under, where the log named one. No label at
          all otherwise: an absent account is a receipt that named none, not a figure
          this console is missing. */}
      {chapter.payingAccountId === undefined ? null : (
        <span className="meridian-chapter-header__account">
          {"billed to "}
          <span className="meridian-chapter-header__figure">{chapter.payingAccountId}</span>
        </span>
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
      {/* Only while the chapter is open, because a folded chapter draws its header and
          its receipt and nothing else — mounting a scroller inside a fold would be the
          fold showing rows it exists to put away. */}
      {props.isOpen ? <ChapterBodyViewport chapter={chapter} /> : null}
    </div>
  );
}
