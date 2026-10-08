import type { WorkflowRunsPauseState } from "@ai-sidekicks/contracts/workflow/run/records";

import { TryAgainButton } from "#renderer/components/TryAgainButton/TryAgainButton.js";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { Switch } from "#renderer/components/Switch/Switch.js";
import { DerivedFigure } from "#renderer/components/DerivedFigure/DerivedFigure.js";
import { formatCount } from "#renderer/lib/wire/figures.js";
import type { WorkflowCallState } from "../hooks/useWorkflowCall.js";
import type { NextWaiting } from "../hooks/useWorkflowsScreen.js";
import type { WorkflowNoticeFeedState } from "../notice-feed.js";
import { ActionButton } from "./ActionButton.js";

/**
 * The Runs tab's own strip, above the list and a run's page alike: `Next waiting (N)` at its left,
 * which opens the next run waiting on a person and stands disabled reading `Nothing waiting` when
 * there is none, and the `Pause new runs` switch at its right, which holds every new start, lets a
 * run already going finish, and reads how many starts are waiting; while it is on, a quiet line
 * beside it says what the hold does. Until what is waiting has been read the control reads
 * `Next waiting` with no count, and a read that failed is drawn here on a run's page, where the
 * list's own attention section is not.
 */
export function RunsStrip(props: {
  readonly nextWaiting: NextWaiting;
  readonly readAttentionAgain: () => void;
  readonly isRunPageOpen: boolean;
  readonly onOpenRun: (workflowRunId: string) => void;
  readonly feedState: WorkflowNoticeFeedState;
  readonly pauseAct: WorkflowCallState<WorkflowRunsPauseState>;
  readonly onSetPaused: (paused: boolean) => void;
}): React.JSX.Element {
  const { nextWaiting, feedState, pauseAct } = props;
  const nextRunId = nextWaiting.kind === "loaded" ? nextWaiting.workflowRunId : undefined;
  const pause = feedState.kind === "open" ? feedState.pause : undefined;
  return (
    <div className="meridian-workflows-strip">
      <ActionButton
        disabled={nextRunId === undefined}
        onClick={() => {
          if (nextRunId !== undefined) {
            props.onOpenRun(nextRunId);
          }
        }}
      >
        {nextWaitingWords(nextWaiting)}
      </ActionButton>
      {nextWaiting.kind === "failed" && props.isRunPageOpen ? (
        <InlineRefusal
          code={nextWaiting.refusal.code}
          detail={nextWaiting.refusal.detail}
          action={<TryAgainButton onPress={props.readAttentionAgain} />}
          attempt={nextWaiting.refusal}
        />
      ) : null}
      {pause?.paused === true ? (
        <span className="meridian-workflows-strip__hold-note">
          Runs already going finish; held ones start when you switch this off.
        </span>
      ) : null}
      {feedState.kind === "failed" ? (
        <InlineRefusal code={feedState.refusal.code} detail={feedState.refusal.detail} />
      ) : (
        <PauseSwitch pause={pause} act={pauseAct} onSetPaused={props.onSetPaused} />
      )}
    </div>
  );
}

function nextWaitingWords(nextWaiting: NextWaiting): React.ReactNode {
  if (nextWaiting.kind !== "loaded") {
    return "Next waiting";
  }
  // The count is the app's own tally of the runs the daemon listed as waiting on a person.
  return nextWaiting.workflowRunId === undefined ? (
    "Nothing waiting"
  ) : (
    <>
      Next waiting (<DerivedFigure text={formatCount(nextWaiting.count)} />)
    </>
  );
}

function PauseSwitch(props: {
  readonly pause: WorkflowRunsPauseState | undefined;
  readonly act: WorkflowCallState<WorkflowRunsPauseState>;
  readonly onSetPaused: (paused: boolean) => void;
}): React.JSX.Element {
  const { pause, act } = props;
  const isPaused = pause?.paused === true;
  const waiting =
    isPaused && pause.waitingStartCount > 0
      ? ` · ${formatCount(pause.waitingStartCount)} waiting`
      : "";
  return (
    <span className="meridian-workflows-strip__pause">
      <Switch
        label={`Pause new runs${waiting}`}
        checked={isPaused}
        // The hold is read from the stream, which opens with it; until it has, there is no state
        // to flip.
        disabled={pause === undefined || act.kind === "sending"}
        onCheckedChange={props.onSetPaused}
      />
      {act.kind === "refused" ? (
        <InlineRefusal code={act.refusal.code} detail={act.refusal.detail} />
      ) : null}
    </span>
  );
}
