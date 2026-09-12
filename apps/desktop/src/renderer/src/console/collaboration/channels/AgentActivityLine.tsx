// One line saying that a sidekick is working in this channel right now.
//
// A pure render over what `activity-model.ts` holds. Every decision about WHEN an
// indicator exists — the edge that writes it, the edge that clears it, the rule that
// `since` is display-only — is the registry's; this component's only judgement is how
// many names fit on a line before the line stops being information.
//
// IT RENDERS NOTHING WHEN THERE IS NOTHING. Not an empty strip, not a reserved
// height, not a placeholder: absence is the ordinary state of this surface, and a
// row that held space for it would put a permanent gap in every channel list. The
// component returns `null` and the layout closes over it.
//
// IT CARRIES NO CONTENT. The indicator says which run and where. There is no message
// text to render here because none is ever transmitted.

import { DerivedFigure, Glyph, formatCount } from "../../primitives/index.js";
import type { ChannelActivity, ChannelActivityLabels } from "../activity-model.js";
import { AGENT_RUNS_NAMED_CAP } from "../../core/index.js";
import { GLYPH_SIZE_ROW } from "../../tokens/index.js";

export interface AgentActivityLineProps {
  readonly activity: ChannelActivity;
  /**
   * How a run becomes words.
   *
   * The agent's name is resolved from the run id against the session projection,
   * because the activity field carries a run id and no name. Handed in rather than
   * looked up here so this component holds no store.
   */
  readonly labels: ChannelActivityLabels;
}

export function AgentActivityLine(props: AgentActivityLineProps): React.JSX.Element | null {
  const { activity, labels } = props;
  if (activity.agentRuns.length === 0) {
    return null;
  }

  return (
    <p className="meridian-activity" role="status">
      <span className="meridian-activity__part meridian-activity__part--running">
        <Glyph name="run" size={GLYPH_SIZE_ROW} />
        <DerivedFigure text={agentSentence(activity, labels)} />
      </span>
    </p>
  );
}

/**
 * Which agents are working, in words.
 *
 * Above {@link AGENT_RUNS_NAMED_CAP} the names churn faster than they can be read, and
 * what a person wants from a fourth run is that the room is busy — so the line folds
 * to a count, which goes through the figure formatter like every other number the
 * console derives. A run whose agent the session projection does not name yet reads as
 * its own run id rather than as a blank — the id is a wire string the operator can act
 * on, and a blank is not.
 */
function agentSentence(activity: ChannelActivity, labels: ChannelActivityLabels): string {
  const names = activity.agentRuns.map((indicator) => labels.runLabel(indicator.runId));
  if (names.length > AGENT_RUNS_NAMED_CAP) {
    return `${formatCount(names.length)} runs are working`;
  }
  return `${names.join(", ")} ${names.length === 1 ? "is" : "are"} working`;
}
