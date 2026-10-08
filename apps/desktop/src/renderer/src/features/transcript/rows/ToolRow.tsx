// The tool card: a call with a body is open until a person folds it, and one without a body is its
// one line with no chevron. The list owns the fold through `density`, so two rows cannot disagree
// about it. The result chip sits outside the fold so a folded error stays visible; a call that
// succeeded draws no chip, since success is shown by absence.
// No tool kind is read from the tool's name; `ToolKindBadge` draws what a row declares.

import "./ToolRow.css";

import { useId } from "react";

import { elideText } from "#renderer/lib/elide-text.js";
import { readWireString } from "#renderer/lib/wire/strings.js";
import { Chip, type ChipTone } from "#renderer/components/Chip/Chip.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { Glyph } from "#renderer/components/Glyph/Glyph.js";
import {
  TranscriptRowLayout,
  hueStepOf,
} from "../components/TranscriptRowLayout/TranscriptRowLayout.js";
import { formatDuration } from "#renderer/lib/wire/figures.js";
import { describeRowKind, isFoldableCall, toolResultState, type ToolResultState } from "./kind.js";
import type { HydratedRowProps } from "./hydrated-props.js";
import { ToolOutput } from "./bodies/ToolOutput.js";
import { ToolKindBadge } from "./tool-kinds/ToolKindBadge.js";
import { readDeclaredToolKind } from "./tool-kinds/vocabulary.js";
import { projectedPayload, readWireCount } from "#renderer/store/session/events/wire-payload.js";

/**
 * Characters of a tool row's one-clause summary before it is elided at a word boundary; at the
 * transcript's measure this is what fits beside the name and elapsed time without wrapping. The
 * wire allows 4096 characters.
 */
const TOOL_SUMMARY_MAX_CHARACTERS = 96;

/** What a mount hands a tool card, beyond the row itself. */
export interface ToolRowProps extends HydratedRowProps {
  /**
   * Fold or open this call, handed the chevron that was pressed. Optional because density belongs
   * to the list: without it the card renders a state rather than a control.
   */
  readonly onDensityToggle?: ((control: HTMLElement) => void) | undefined;
}

/** How each result state reads and which tone it takes; `undefined` draws no chip. */
const RESULT_STATE_CHIPS: Readonly<
  Record<ToolResultState, { label: string; tone: ChipTone } | undefined>
> = {
  // Red means a failure, amber means a person is needed; truncated and unreadable bodies are
  // neither, so they take the neutral chip. `ToolOutput` renders the one red body case, a stored
  // body that does not match its signature.
  running: { label: "Running", tone: "neutral" },
  ok: undefined,
  error: { label: "Error", tone: "failure" },
  truncated: { label: "Truncated", tone: "neutral" },
  "body-unavailable": { label: "Body unavailable", tone: "neutral" },
};

/** A tool-call row: the row kind's glyph and label around its declared arguments and result. */
export function ToolRow(props: ToolRowProps): React.JSX.Element {
  const kind = describeRowKind("tool-call");
  const state = toolResultState(props.row.type, props.content);
  const chip = RESULT_STATE_CHIPS[state];
  const payload = projectedPayload(props.row);
  const toolName = readWireString(payload["toolName"]);
  const durationMs = readWireCount(payload, "durationMs");
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
        {/* Wire-verbatim, in mono. A missing name reads as absent, not "unknown", which the
              daemon never sent. */}
        {toolName === undefined ? (
          <span id={nameId} className="meridian-tool-card__name meridian-tool-card__name--absent">
            No tool name
          </span>
        ) : (
          <span id={nameId} className="meridian-tool-card__name">
            {toolName}
          </span>
        )}{" "}
        {/* Before the summary: the badge qualifies which tool ran, the summary says what it did.
              Draws nothing for a row that declares no tool kind. */}
        <ToolKindBadge reading={readDeclaredToolKind(payload)} />
        <span className="meridian-tool-card__summary">
          {elideText(props.row.summary, TOOL_SUMMARY_MAX_CHARACTERS, { atWordBoundary: true })}
        </span>
        {durationMs === undefined ? null : (
          <>
            {" "}
            <span className="meridian-tool-card__elapsed">
              <WireFigure value={formatDuration(durationMs)} />
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
            onClick={(event) => {
              onDensityToggle(event.currentTarget);
            }}
          >
            <Glyph name={isOpen ? "chevron-down" : "chevron-right"} />
          </button>
        )}
      </div>
      {isOpen ? (
        <ToolOutput
          content={props.content}
          {...(props.liveText === undefined ? {} : { liveText: props.liveText })}
          // No shape is passed: the payload has no tool kind or content type, so any fixed answer
          // (ANSI or prose) would misread some results. `ToolOutput` reads the bytes, and a
          // shape from the tool's name stays the invention `kind.ts` refuses.
          sourceId={props.row.id}
          footnotes={props.footnotes}
          label={`Output of ${toolName ?? "an unnamed tool"}`}
          holdControlInPlace={props.holdControlInPlace}
        />
      ) : null}
    </TranscriptRowLayout>
  );
}
