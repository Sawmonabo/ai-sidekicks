// The tool card — one line until opened.
//
// Tool rows render as one line until opened. `row-kind.ts` owns the five states that
// one line reports, and the density
// budget puts the collapse state in the LIST's hands rather than the row's. So this card renders
// exactly what its `density` prop says and owns no open state: two rows disagreeing
// about whether they are open is a bug a fixture would never surface and a long session
// would.
//
// THE HEADER IS THE WHOLE ROW WHEN COLLAPSED, and it carries the result state
// unconditionally. `row-kind.ts`'s ranking rule — never hide a tool error inside a
// collapsed row without the red mark on the header — is the reason the state chip is
// outside the disclosure and not
// inside it — a collapsed error is still an error, and a reader scanning a log of forty
// tool calls sees the failures without opening one.
//
// WHAT IT DOES NOT DO. It does not read a tool KIND out of the tool's name — see
// `row-kind.ts` for why that would be the console asserting a fact the wire never
// sent — so every tool renders through this one card, and the name renders wire-verbatim
// in mono beside it. The same refusal decides how the BODY is drawn: the wire declares
// no shape for a tool result, so it is drawn as prose rather than as terminal output
// guessed at from the tool that produced it.
//
// AND WHAT IT HOLDS INSTEAD OF THAT REFUSAL'S CONSEQUENCE. The design's six tool
// treatments — command output, file edits, read folds, MCP calls with a server badge and a
// typed argument summary, web-search result lists, image results — need a home for the
// wire member. The tool kind reader and `ToolKindBadge` are that home: the vocabulary as
// data, one fail-closed reading off this row's own payload, and a renderer the treatments
// supply. The refusal is unchanged — this card still derives nothing from the tool's name.

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
   * Open or close this row.
   *
   * Optional because density belongs to the list: where a list supplies no way to
   * change it, the card renders a state rather than a control. The transcript's row
   * renderer supplies one, which is what makes a collapsed tool row openable before the real
   * list exists.
   */
  readonly onDensityToggle?: (() => void) | undefined;
  /**
   * The tool kind treatment's renderer, or `undefined` while the built-in badge stands in.
   *
   * Required and carrying `undefined` rather than optional, so a caller that forgot it is
   * a compile error at the construction site instead of an absent key that reads the same
   * as a deliberate "none".
   */
  readonly toolKindRenderer: ToolKindRenderer | undefined;
}

/** How each result state reads, and in which of the console's two hues. */
const RESULT_STATE_CHIPS: Readonly<Record<ToolResultState, { label: string; tone: ChipTone }>> = {
  // The two-hue rule is why only one of these five is colored. Red means a failure;
  // amber means a person is needed. A truncated body and an unreadable one are neither —
  // nobody is being asked for anything and nothing failed — so they say what they are in
  // words and take the neutral chip. `ToolOutput` renders the one genuinely red case,
  // a stored body that does not match its signature, where the body itself is.
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
          {/* Wire-verbatim, in mono, through the console's one figure primitive. A tool
              with no name on its payload is named as absent rather than as "unknown",
              which would be a word the daemon never sent. */}
          {toolName === undefined ? (
            <span className="meridian-tool-card__name meridian-tool-card__name--absent">
              No tool name
            </span>
          ) : (
            <span className="meridian-tool-card__name">{toolName}</span>
          )}
          {/* BEFORE THE SUMMARY, because the treatment qualifies WHICH tool ran and
              the summary says what it did. Draws nothing at all for a row declaring
              no tool kind, which is every row this build can receive. */}
          <ToolKindBadge body={props.toolKindRenderer} reading={readDeclaredToolKind(payload)} />
          <span className="meridian-tool-card__summary">{clampSummary(props.row.summary)}</span>
          {durationMs === undefined ? null : (
            <span className="meridian-tool-card__elapsed">{formatDuration(durationMs)}</span>
          )}
          <Chip label={chip.label} tone={chip.tone} />
          {props.onDensityToggle === undefined ? null : (
            <button
              type="button"
              // The second class is the row layout's reveal class: the row layout owns
              // WHEN a secondary control appears and this card owns what it is, so
              // neither sheet has to name the other's class.
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
            // NO SHAPE IS PASSED, BECAUSE THIS CARD HAS NONE TO GIVE. The tool
            // payload carries a name, a call id, a duration and the body's own
            // descriptors, and no member at all that says what SHAPE the body is — no
            // tool kind, no content type. A card that answered "ANSI" for every
            // result was reading terminal output into an MCP reply, a web-search
            // answer, and every other ordinary textual result; one that answered
            // "prose" for every result put a shell's escape sequences on the page as
            // text. `ToolOutput` reads the bytes, which is the one thing the wire
            // does supply, and deriving a shape from the tool's NAME stays the
            // invention `row-kind.ts` refuses.
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
 * One clause of the row's own summary.
 *
 * One line leaves room for one clause, and the wire's `summary` is bounded at 4096
 * characters — three orders of magnitude past a clause. Truncation is at a word boundary
 * where one is near the cap and at the cap otherwise, with an ellipsis, so the header
 * never reflows the row it is supposed to keep to one line.
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
 * The row's step on the twelve-step wheel, or a step outside it.
 *
 * `-1` rather than `0`: step zero belongs to somebody, and `TranscriptRowLayout` treats any step
 * outside the wheel as unattributed and falls back to the neutral control boundary. That
 * is the fail-closed answer, and it is the primitive's rule rather than a second one.
 */
function hueStepOf(props: Pick<ToolRowProps, "actorHue">): number {
  return props.actorHue?.step ?? -1;
}
