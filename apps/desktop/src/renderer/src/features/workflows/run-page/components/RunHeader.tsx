import type { EventCursor } from "@ai-sidekicks/contracts/session/session";
import type { WorkflowRunSnapshotPoint } from "@ai-sidekicks/contracts/gitflow/local";
import type { WorkflowRunReadResponse } from "@ai-sidekicks/contracts/workflow/run/records";

import { parseInstant } from "@renderer/lib/instant.js";
import { formatCount, formatDayClock } from "@renderer/lib/wire/figures.js";
import { Chip } from "@renderer/components/Chip/Chip.js";
import { callDaemon } from "@renderer/services/daemon/daemon-reply.js";
import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { RunStatusChip } from "../../components/RunStatusChip.js";
import { useRunTimesNow } from "../../hooks/useRunTimesNow.js";
import { useWorkflowAct } from "../../hooks/useWorkflowAct.js";
import { runDurationWords } from "../../run-duration.js";
import { costWithPayer } from "../../run-cost.js";
import { TRIGGER_KIND_WORDS, startedByWords } from "../../workflow-words.js";
import { isGoing, runHeaderControlAvailability } from "../../run-controls.js";
import { runHeaderLines, runLiveLine } from "../run-header-lines.js";
import { latestStepWith } from "../../run-steps.js";
import { RunControl } from "../../components/RunControl.js";
import { OpenInReview } from "./OpenInReview.js";

/** What a run's header is drawn from, and where its links lead. */
export interface RunHeaderProps {
  readonly run: WorkflowRunReadResponse;
  /** The workflow's name, once it has been read. */
  readonly workflowName: string | undefined;
  /** The pinned version's number, once the version has been read; its chip waits for it. */
  readonly versionNumber: number | undefined;
  /** A step's node kind in the pinned version, which names the step; `undefined` until read. */
  readonly nodeKind: (nodeId: string) => string | undefined;
  readonly accountLabel: (providerAccountId: string) => string | undefined;
  readonly bridge: PlatformBridge;
  readonly onOpenRun: (workflowRunId: string) => void;
  readonly onOpenSession: (sessionId: string) => void;
  /** Open the session that started the run with its starting message in view. */
  readonly onOpenMessage: (sessionId: string, messageAnchorCursor: EventCursor | undefined) => void;
  /** Open the workflow the run came from. */
  readonly onOpenWorkflow: (definitionId: string) => void;
  /** Open Review on what the run changed between two of its snapshots. */
  readonly onOpenReview: (from: WorkflowRunSnapshotPoint, to: WorkflowRunSnapshotPoint) => void;
}

/**
 * A run's header: what happened and what it needs, the run's facts and links, its three
 * controls and `Open in Review` once it has finished, and while it is going, the live line
 * directly above the graph.
 */
export function RunHeader(props: RunHeaderProps): React.JSX.Element {
  const { run, bridge } = props;
  const workflowRunId = run.workflowRunId;
  const { review, startedBy } = run;
  // The daemon starts the new run from this run's own version, input and mode.
  const rerun = useWorkflowAct(
    () => callDaemon(bridge, "workflow.runRerun", { workflowRunId }),
    (started) => {
      props.onOpenRun(started.workflowRunId);
    },
  );
  const cancel = useWorkflowAct(() => callDaemon(bridge, "workflow.runCancel", { workflowRunId }));
  const resume = useWorkflowAct(() => callDaemon(bridge, "workflow.runResume", { workflowRunId }));
  const isChained = run.chainRoot.runId !== workflowRunId;
  const isTicking = isGoing(run.state);
  // The day words move at midnight and a going run's time so far every second.
  const nowMs = useRunTimesNow({
    drawn: [run],
    isTicking,
    namesDays: true,
    isPartOfDayShown: false,
  });
  const lines = runHeaderLines(run, props.nodeKind, nowMs);
  const liveLine = runLiveLine(run, nowMs);
  const durationWords = runDurationUntil(run, isTicking, nowMs);
  const waiting = latestStepWith(run.steps, "waiting");
  const chainStartedAt = formatDayClock(run.chainRoot.startedAt, nowMs);

  return (
    <header className="meridian-workflow-run__header">
      <div className="meridian-workflow-run__lines">
        <h2 className="meridian-workflow-run__happened">{lines.happened}</h2>
        <p className="meridian-workflow-run__needs">{lines.needs}</p>
      </div>
      <dl className="meridian-workflow-run__facts">
        <Fact term="Status">
          <RunStatusChip status={run.state} waitCause={waiting?.waitCause} />
        </Fact>
        <Fact term="Workflow">
          {props.workflowName}
          {props.versionNumber === undefined ? null : (
            <Chip label={`version v${formatCount(props.versionNumber)} pinned`} />
          )}
        </Fact>
        <Fact term="Started">{formatDayClock(run.startedAt, nowMs)}</Fact>
        {durationWords === undefined ? null : <Fact term="Duration">{durationWords}</Fact>}
        <Fact term="Trigger">{TRIGGER_KIND_WORDS[run.triggerKind]}</Fact>
        <Fact term="Started by">
          {startedByWords(run.startedBy)}
          {isChained ? (
            <>
              {" · "}
              <button
                type="button"
                className="meridian-workflow-run__link"
                onClick={() => {
                  props.onOpenRun(run.chainRoot.runId);
                }}
              >
                {`Started by ${run.chainRoot.workflowName} · ${chainStartedAt}`}
              </button>
            </>
          ) : null}
        </Fact>
        <Fact term="Cost">{costWithPayer(run.cost, props.accountLabel)}</Fact>
        {run.failureReason === undefined ? null : <Fact term="Reason">{run.failureReason}</Fact>}
      </dl>
      <div className="meridian-workflow-run__links">
        <HeaderLink
          label="Open the workflow"
          onPress={() => {
            props.onOpenWorkflow(run.definitionId);
          }}
        />
        {startedBy.kind === "parentWorkflow" ? (
          <HeaderLink
            label="Open the run that called it"
            onPress={() => {
              props.onOpenRun(startedBy.parentWorkflowRunId);
            }}
          />
        ) : null}
        {startedBy.kind === "chat" ? (
          <HeaderLink
            label="Open the message that started it"
            onPress={() => {
              props.onOpenMessage(startedBy.sessionId, startedBy.messageAnchorCursor);
            }}
          />
        ) : null}
        {run.fixSessionId === undefined ? null : (
          <HeaderLink
            label="Open the fix session"
            onPress={() => {
              if (run.fixSessionId !== undefined) {
                props.onOpenSession(run.fixSessionId);
              }
            }}
          />
        )}
      </div>
      <div className="meridian-workflow-run__controls">
        <RunControl
          label="Re-run"
          availability={runHeaderControlAvailability("rerun", run)}
          act={rerun.state}
          onPress={() => {
            rerun.take(undefined);
          }}
        />
        <RunControl
          label="Cancel"
          availability={runHeaderControlAvailability("cancel", run)}
          act={cancel.state}
          onPress={() => {
            cancel.take(undefined);
          }}
        />
        <RunControl
          label="Resume"
          availability={runHeaderControlAvailability("resume", run)}
          act={resume.state}
          onPress={() => {
            resume.take(undefined);
          }}
        />
        {review === undefined ? null : (
          <OpenInReview
            door={
              review.state === "pinned"
                ? {
                    state: "pinned",
                    from: { epoch: review.epoch, point: "start" },
                    to: { epoch: review.epoch, point: "end" },
                  }
                : review
            }
            onOpenReview={props.onOpenReview}
          />
        )}
      </div>
      {liveLine === undefined ? null : (
        <p className="meridian-workflow-run__live">
          {liveLine.map((part, index) => (
            <span
              key={index}
              className={
                part.isAttention
                  ? "meridian-workflow-run__live-part meridian-workflow-run__live-part--attention"
                  : "meridian-workflow-run__live-part"
              }
            >
              {part.text}
            </span>
          ))}
        </p>
      )}
    </header>
  );
}

function Fact(props: {
  readonly term: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="meridian-workflow-run__fact">
      <dt>{props.term}</dt>
      <dd>{props.children}</dd>
    </div>
  );
}

function HeaderLink(props: {
  readonly label: string;
  readonly onPress: () => void;
}): React.JSX.Element {
  return (
    <button type="button" className="meridian-workflow-run__link" onClick={props.onPress}>
      {props.label}
    </button>
  );
}

/**
 * How long the run took, or while it is going how long it has taken so far; `undefined` for a
 * failed run parked on its step, which has neither ended nor kept going.
 */
function runDurationUntil(
  run: WorkflowRunReadResponse,
  isTicking: boolean,
  nowMs: number,
): string | undefined {
  if (isTicking) {
    return runDurationWords(run.startedAt, nowMs);
  }
  const ended = run.endedAt === undefined ? undefined : parseInstant(run.endedAt);
  return ended?.kind === "instant"
    ? runDurationWords(run.startedAt, ended.epochMilliseconds)
    : undefined;
}
