// The tool card: a call with a body is open until a person folds it, and one without a body is its
// one line with no chevron. The list owns the fold through `density`, so two rows cannot disagree
// about it. The result chip sits outside the fold so a folded error stays visible; a call that
// succeeded draws no chip, since success is shown by absence.
// No tool kind is read from the tool's name; `ToolKindBadge` draws what a row declares.

import "./ToolRow.css";

import { useId } from "react";

import { Chip } from "#renderer/components/Chip/Chip.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { Glyph } from "#renderer/components/Glyph/Glyph.js";
import {
  TranscriptRowLayout,
  hueStepOf,
} from "../components/TranscriptRowLayout/TranscriptRowLayout.js";
import { describeRowKind, isFoldableCall } from "./kind.js";
import type { TranscriptCardProps } from "./card-props.js";
import { type OutputOpening } from "./bodies/OutputHeightCut.js";
import { ToolOutput } from "./bodies/ToolOutput.js";
import { ToolKindBadge } from "./tool-kinds/ToolKindBadge.js";
import { ABSENT_TOOL_NAME_LABEL, toolRowHeadingOf } from "./tool-heading.js";

/** What a mount hands a tool card, beyond the row itself. */
export interface ToolRowProps extends TranscriptCardProps {
  /**
   * Fold or open this call. Optional because density belongs to the list: without it the card
   * renders a state rather than a control.
   */
  readonly onDensityToggle?: (() => void) | undefined;
  /**
   * The call's output's opening, held by the list so an opened output stays whole when the row
   * scrolls out and back; without it the output is drawn whole.
   */
  readonly outputOpening?: OutputOpening | undefined;
}

/** A tool-call row: the row kind's glyph and label around its declared arguments and result. */
export function ToolRow(props: ToolRowProps): React.JSX.Element {
  const kind = describeRowKind("tool-call");
  const heading = toolRowHeadingOf(props.row, props.row.content);
  const { toolName, resultChip: chip } = heading;
  const isFoldable = isFoldableCall(props.row, props.liveText !== undefined);
  const isOpen = isFoldable && props.density === "expanded";
  const onDensityToggle = props.onDensityToggle;
  // The chevron carries no words of its own: it is named by the tool's name beside it.
  const nameId = useId();

  return (
    <TranscriptRowLayout
      agentHueStep={hueStepOf(props.agentHue)}
      occurredAtIso={props.row.timestamp}
      authorLabel={props.row.actor ?? kind.label}
      isSuperseded={props.isSuperseded}
    >
      {/* A space between two of the header's parts draws nothing in its flex row; it keeps them
            apart in text copied out of it. */}
      <div className="meridian-tool-card__header">
        <Glyph name={kind.glyph} title={kind.label} />
        {/* Which tool ran. It takes the line's free space, so what follows sits at its end. */}
        <span className="meridian-tool-card__tool">
          {/* Wire-verbatim, in mono. A missing name reads as absent, not "unknown", which the
                daemon never sent. */}
          {toolName === undefined ? (
            <span id={nameId} className="meridian-tool-card__name meridian-tool-card__name--absent">
              {ABSENT_TOOL_NAME_LABEL}
            </span>
          ) : (
            <span id={nameId} className="meridian-tool-card__name">
              {toolName}
            </span>
          )}
          {/* The badge qualifies the tool; it draws nothing for a row that declares no kind. */}
          <ToolKindBadge reading={heading.toolKind} />
        </span>
        {heading.elapsed === undefined ? null : (
          <>
            {" "}
            <span className="meridian-tool-card__elapsed">
              <WireFigure value={heading.elapsed} />
            </span>
          </>
        )}
        {chip === undefined ? null : (
          <>
            {" "}
            <Chip label={chip.label} tone={chip.tone} />
          </>
        )}
        {/* A call with no body has nothing to fold, so it draws no chevron and no tab stop. */}
        {!isFoldable || onDensityToggle === undefined ? null : (
          <button
            type="button"
            // The second class is the row layout's reveal class: the layout owns when a
            // secondary control appears and this card owns what it is.
            className="meridian-tool-card__disclosure meridian-transcript-row-layout__revealed"
            aria-expanded={isOpen}
            aria-labelledby={nameId}
            onClick={() => {
              onDensityToggle();
            }}
          >
            <Glyph name={isOpen ? "chevron-down" : "chevron-right"} />
          </button>
        )}
      </div>
      {isOpen ? (
        <ToolOutput
          content={props.row.content}
          {...(props.liveText === undefined ? {} : { liveText: props.liveText })}
          // No shape is passed: the payload has no tool kind or content type, so any fixed answer
          // (ANSI or prose) would misread some results. `ToolOutput` reads the bytes, and a
          // shape from the tool's name stays the invention `kind.ts` refuses.
          sourceId={props.row.id}
          footnotes={props.footnotes}
          label={`Output of ${toolName ?? "an unnamed tool"}`}
          opening={props.outputOpening}
          holdRowInPlace={props.holdRowInPlace}
        />
      ) : null}
    </TranscriptRowLayout>
  );
}
