// The tool card: one line until opened. The list owns the collapse state through `density`, so
// two rows cannot disagree about it. The result chip sits outside the disclosure so a collapsed
// error stays visible. No tool kind is read from the tool's name (the wire declares none);
// `ToolKindBadge` is where a declared kind plugs in.

import { TOOL_SUMMARY_MAX_CHARACTERS } from "../cards/card-caps.js";
import { readWireString } from "@renderer/lib/wire-strings.js";
import { Chip, type ChipTone } from "@renderer/components/Chip/Chip.js";
import { Glyph } from "@renderer/components/Glyph/Glyph.js";
import { TranscriptRowLayout } from "../components/TranscriptRowLayout/TranscriptRowLayout.js";
import { formatDuration } from "@renderer/lib/wire-figures.js";
import { TranscriptRowGroup } from "../viewport/components/TranscriptRowGroup.js";
import { describeRowKind, toolResultState, type ToolResultState } from "./row-kind.js";
import type { HydratedRowProps } from "./hydrated-row-props.js";
import { ToolOutput } from "./bodies/ToolOutput.js";
import { ToolKindBadge } from "./tool-kinds/ToolKindBadge.js";
import { readDeclaredToolKind, type ToolKindRenderer } from "./tool-kinds/tool-kinds.js";
import { projectedPayload, readWireCount } from "@renderer/store/session-events/wire-payload.js";

/** What a mount hands a tool card, beyond the row itself. */
export interface ToolRowProps extends HydratedRowProps {
  /**
   * Open or close this row. Optional because density belongs to the list: without it the card
   * renders a state rather than a control.
   */
  readonly onDensityToggle?: (() => void) | undefined;
  /**
   * The tool kind treatment's renderer, or `undefined` while the built-in badge stands in.
   * Required-with-undefined so a caller that forgot it fails to compile.
   */
  readonly toolKindRenderer: ToolKindRenderer | undefined;
}

/** How each result state reads and which tone it takes. */
const RESULT_STATE_CHIPS: Readonly<Record<ToolResultState, { label: string; tone: ChipTone }>> = {
  // Red means a failure, amber means a person is needed; truncated and unreadable bodies are
  // neither, so they take the neutral chip. `ToolOutput` renders the one red body case, a stored
  // body that does not match its signature.
  running: { label: "Running", tone: "neutral" },
  ok: { label: "Ok", tone: "neutral" },
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
  const isOpen = props.density === "expanded";

  return (
    <TranscriptRowGroup groupLabel="a tool row">
      <TranscriptRowLayout
        agentHueStep={hueStepOf(props)}
        occurredAtIso={props.row.timestamp}
        authorLabel={props.row.actor ?? kind.label}
        kindLabel={props.row.type}
        isSuperseded={props.isSuperseded}
      >
        <div className="meridian-tool-card__header">
          <Glyph name={kind.glyph} title={kind.label} />
          {/* Wire-verbatim, in mono. A missing name reads as absent, not "unknown", which the
              daemon never sent. */}
          {toolName === undefined ? (
            <span className="meridian-tool-card__name meridian-tool-card__name--absent">
              No tool name
            </span>
          ) : (
            <span className="meridian-tool-card__name">{toolName}</span>
          )}
          {/* Before the summary: the badge qualifies which tool ran, the summary says what it did.
              Draws nothing for a row that declares no tool kind. */}
          <ToolKindBadge body={props.toolKindRenderer} reading={readDeclaredToolKind(payload)} />
          <span className="meridian-tool-card__summary">{clampSummary(props.row.summary)}</span>
          {durationMs === undefined ? null : (
            <span className="meridian-tool-card__elapsed">{formatDuration(durationMs)}</span>
          )}
          <Chip label={chip.label} tone={chip.tone} />
          {props.onDensityToggle === undefined ? null : (
            <button
              type="button"
              // The second class is the row layout's reveal class: the layout owns when a
              // secondary control appears and this card owns what it is.
              className="meridian-tool-card__disclosure meridian-transcript-row-layout__revealed"
              aria-expanded={isOpen}
              onClick={props.onDensityToggle}
            >
              <Glyph name={isOpen ? "chevron-down" : "chevron-right"} />
              {isOpen ? "Close" : "Open"}
            </button>
          )}
        </div>
        {isOpen ? (
          <ToolOutput
            content={props.content}
            {...(props.liveText === undefined ? {} : { liveText: props.liveText })}
            // No shape is passed: the payload has no tool kind or content type, so any fixed answer
            // (ANSI or prose) would misread some results. `ToolOutput` reads the bytes, and a
            // shape from the tool's name stays the invention `row-kind.ts` refuses.
            sourceId={props.row.id}
            footnotes={props.footnotes}
            label={`Output of ${toolName ?? "an unnamed tool"}`}
          />
        ) : null}
      </TranscriptRowLayout>
    </TranscriptRowGroup>
  );
}

/**
 * One clause of the row's own summary, elided with an ellipsis at a word boundary near the cap
 * (or at the cap), so the header never reflows past one line. The wire allows 4096 characters.
 */
export function clampSummary(summary: string): string {
  if (summary.length <= TOOL_SUMMARY_MAX_CHARACTERS) {
    return summary;
  }
  const head = summary.slice(0, TOOL_SUMMARY_MAX_CHARACTERS);
  const lastSpace = head.lastIndexOf(" ");
  const kept = lastSpace > TOOL_SUMMARY_MAX_CHARACTERS / 2 ? head.slice(0, lastSpace) : head;
  return `${kept.trimEnd()}…`;
}

/**
 * The row's step on the hue wheel, or `-1`, which `TranscriptRowLayout` treats as unattributed
 * (neutral boundary). Not `0`: step zero belongs to somebody.
 */
function hueStepOf(props: Pick<ToolRowProps, "agentHue">): number {
  return props.agentHue?.step ?? -1;
}
