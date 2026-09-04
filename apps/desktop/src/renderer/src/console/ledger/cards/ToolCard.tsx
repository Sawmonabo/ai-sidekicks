// The tool card — one line until opened.
//
// `Spec-023 §Meridian, the design language` rule 7: "Tool rows render as one line until
// opened." `card-family.ts` owns the five states that one line reports, and the density
// budget puts the collapse state in the LIST's hands rather than the row's. So this card renders
// exactly what its `density` prop says and owns no open state: two rows disagreeing
// about whether they are open is a bug a fixture would never surface and a long session
// would.
//
// THE HEADER IS THE WHOLE ROW WHEN COLLAPSED, and it carries the result state
// unconditionally. `card-family.ts`'s ranking rule — never hide a tool error inside a
// collapsed row without the red mark on the header — is the reason the state chip is
// outside the disclosure and not
// inside it — a collapsed error is still an error, and a reader scanning a log of forty
// tool calls sees the failures without opening one.
//
// WHAT IT DOES NOT DO. It does not read a tool FAMILY out of the tool's name — see
// `card-family.ts` for why that would be the console asserting a fact the wire never
// sent — so every tool renders through this one card, and the name renders wire-verbatim
// in mono beside it.

import { Chip, Glyph, LedgerRow, formatDuration, type ChipTone } from "../../primitives/index.js";
import { LedgerRowGroup } from "../frame/index.js";
import { TOOL_SUMMARY_MAX_CHARACTERS } from "./card-bounds.js";
import { cardFamilyDescriptor, toolResultState, type ToolResultState } from "./card-family.js";
import type { LedgerCardProps } from "./card-props.js";
import { MachineBody } from "./MachineBody.js";
import { projectedPayload, readWireCount, readWireString } from "./wire-payload.js";

export interface ToolCardProps extends LedgerCardProps {
  /**
   * Open or close this row.
   *
   * Optional because density belongs to the list: where a list supplies no way to
   * change it, the card renders a state rather than a control. The fixture shell
   * supplies one, which is what makes a collapsed tool row openable before Plan-013's
   * list exists.
   */
  readonly onDensityToggle?: (() => void) | undefined;
}

/** How each result state reads, and in which of the console's two hues. */
const RESULT_STATE_CHIPS: Readonly<Record<ToolResultState, { label: string; tone: ChipTone }>> = {
  // The two-hue rule is why only one of these five is coloured. Red means a failure;
  // amber means a person is needed. A truncated body and an unreadable one are neither —
  // nobody is being asked for anything and nothing failed — so they say what they are in
  // words and take the neutral chip. `MachineBody` renders the one genuinely red case,
  // a stored body that does not match its signature, where the body itself is.
  running: { label: "Running", tone: "neutral" },
  ok: { label: "Ok", tone: "neutral" },
  error: { label: "Error", tone: "failure" },
  truncated: { label: "Truncated", tone: "neutral" },
  "body-unavailable": { label: "Body unavailable", tone: "neutral" },
};

export function ToolCard(props: ToolCardProps): React.JSX.Element {
  const family = cardFamilyDescriptor("tool-activity");
  const state = toolResultState(props.row.type, props.content);
  const chip = RESULT_STATE_CHIPS[state];
  const payload = projectedPayload(props.row);
  const toolName = readWireString(payload, "toolName");
  const durationMs = readWireCount(payload, "durationMs");
  const isOpen = props.density === "expanded";

  return (
    <LedgerRowGroup groupLabel="a tool row">
      <LedgerRow
        participantHueStep={hueStepOf(props)}
        {...(props.participantHue === undefined
          ? {}
          : { ringTreatment: props.participantHue.ringTreatment })}
        occurredAtIso={props.row.timestamp}
        actorLabel={props.row.actor ?? family.label}
        kindLabel={props.row.type}
        isSuperseded={props.isSuperseded}
      >
        <div className="meridian-tool-card__header">
          <Glyph name={family.glyph} title={family.label} />
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
          <span className="meridian-tool-card__summary">{clampSummary(props.row.summary)}</span>
          {durationMs === undefined ? null : (
            <span className="meridian-tool-card__elapsed">{formatDuration(durationMs)}</span>
          )}
          <Chip label={chip.label} tone={chip.tone} />
          {props.onDensityToggle === undefined ? null : (
            <button
              type="button"
              className="meridian-tool-card__disclosure"
              aria-expanded={isOpen}
              onClick={props.onDensityToggle}
            >
              <Glyph name={isOpen ? "chevron-down" : "chevron-right"} />
              {isOpen ? "Close" : "Open"}
            </button>
          )}
        </div>
        {isOpen ? (
          <MachineBody
            content={props.content}
            {...(props.liveText === undefined ? {} : { liveText: props.liveText })}
            kind="command-output"
            sourceId={props.row.id}
            footnotes={props.footnotes}
            label={`Output of ${toolName ?? "an unnamed tool"}`}
          />
        ) : null}
      </LedgerRow>
    </LedgerRowGroup>
  );
}

/**
 * The row's step on the twelve-step wheel, or a step outside it.
 *
 * `-1` rather than `0`: step zero belongs to somebody, and `LedgerRow` treats any step
 * outside the wheel as unattributed and falls back to the neutral control boundary. That
 * is the fail-closed answer, and it is the primitive's rule rather than a second one.
 */
function hueStepOf(props: Pick<ToolCardProps, "participantHue">): number {
  return props.participantHue?.step ?? -1;
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
