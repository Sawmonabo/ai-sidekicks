// One line saying that something is happening in this channel right now.
//
// A pure render over what `activity-model.ts` holds. Every decision about WHEN an
// indicator exists — the two bounds, the two mechanisms, the rule that `since` is
// display-only — is the registry's; this component's only judgement is how many
// names fit on a line before the line stops being information.
//
// IT RENDERS NOTHING WHEN THERE IS NOTHING. Not an empty strip, not a reserved
// height, not a placeholder: absence is the ordinary state of this surface, and a
// row that held space for it would put a permanent gap in every channel list. The
// component returns `null` and the layout closes over it.
//
// IT CARRIES NO CONTENT. The composing indicator says who and where. There is no
// message text to render here because none is ever transmitted, and the two things
// it does show — a name and a hue — are already on the screen beside it.

import { DerivedFigure, Glyph, formatCount } from "../../primitives/index.js";
import type { ChannelActivity, ChannelActivityLabels } from "../activity-model.js";
import { COMPOSING_NAMED_CAP } from "../../core/index.js";
import { GLYPH_SIZE_ROW } from "../../tokens/index.js";

export interface TypingActivityProps {
  readonly activity: ChannelActivity;
  /**
   * How a participant and a run become words.
   *
   * The agent's name is resolved from the run id against the session projection,
   * because the activity field carries a run id and no name. Handed in rather than
   * looked up here so this component holds no store.
   */
  readonly labels: ChannelActivityLabels;
}

export function TypingActivity(props: TypingActivityProps): React.JSX.Element | null {
  const { activity, labels } = props;
  if (activity.composing.length === 0 && activity.agentRuns.length === 0) {
    return null;
  }

  return (
    <p className="meridian-activity" role="status">
      {activity.composing.length === 0 ? null : (
        <span className="meridian-activity__part meridian-activity__part--composing">
          <Glyph name="pencil" size={GLYPH_SIZE_ROW} />
          <DerivedFigure text={composingSentence(activity, labels)} />
        </span>
      )}
      {activity.agentRuns.length === 0 ? null : (
        <span className="meridian-activity__part meridian-activity__part--running">
          <Glyph name="run" size={GLYPH_SIZE_ROW} />
          <DerivedFigure text={agentSentence(activity, labels)} />
        </span>
      )}
    </p>
  );
}

/**
 * Who is composing, in words.
 *
 * Above {@link COMPOSING_NAMED_CAP} the names churn faster than they can be read,
 * and what a person wants from a fourth composer is that the room is busy — so the
 * line folds to a count. The count goes through the figure formatter like every
 * other number the console derives.
 */
function composingSentence(activity: ChannelActivity, labels: ChannelActivityLabels): string {
  const names = activity.composing.map((indicator) =>
    labels.participantLabel(indicator.participantId),
  );
  if (names.length > COMPOSING_NAMED_CAP) {
    return `${formatCount(names.length)} people are composing`;
  }
  if (names.length === 1) {
    return `${String(names[0])} is composing`;
  }
  const leading = names.slice(0, -1).join(", ");
  return `${leading} and ${String(names[names.length - 1])} are composing`;
}

/**
 * Which agents are working, in words.
 *
 * Folded on the same cap and for the same reason. A run whose agent the session
 * projection does not name yet reads as its own run id rather than as a blank —
 * the id is a wire string the operator can act on, and a blank is not.
 */
function agentSentence(activity: ChannelActivity, labels: ChannelActivityLabels): string {
  const names = activity.agentRuns.map((indicator) => labels.runLabel(indicator.runId));
  if (names.length > COMPOSING_NAMED_CAP) {
    return `${formatCount(names.length)} runs are working`;
  }
  return `${names.join(", ")} ${names.length === 1 ? "is" : "are"} working`;
}
