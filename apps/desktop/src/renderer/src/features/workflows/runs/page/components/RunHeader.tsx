import type { EventCursor } from "@ai-sidekicks/contracts/session/event-cursor";
import type {
  SessionPointerControl,
  SessionPointerOutcome,
} from "#renderer/features/workflows/open-session.js";
import type { WorkflowRunReadResponse } from "@ai-sidekicks/contracts/workflow/run/records";

import { parseInstant } from "#renderer/lib/instant.js";
import { formatCount } from "#renderer/lib/wire/figures.js";
import { Chip } from "#renderer/components/Chip/Chip.js";
import { FigureSentence } from "#renderer/components/FigureSentence/FigureSentence.js";
import { callDaemon } from "#renderer/services/daemon/reply.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { useClockLocale } from "#renderer/services/platform/hooks/useClockLocale.js";
import { DayClockFigure } from "#renderer/components/DayClockFigure/DayClockFigure.js";
import { RunStatusChip } from "#renderer/features/workflows/components/RunStatusChip.js";
import { useRunTimesNow } from "#renderer/features/workflows/hooks/useRunTimesNow.js";
import { useWorkflowCall } from "#renderer/features/workflows/hooks/useWorkflowCall.js";
import { runDurationWords } from "../../duration.js";
import { costWithPayer, type PayerReading } from "../../cost.js";
import { TRIGGER_KIND_WORDS, startedByWords } from "#renderer/features/workflows/words.js";
import { isGoing, runHeaderControlAvailability } from "../../controls.js";
import { runHeaderLines, runLiveLine } from "../header-lines.js";
import { latestStepWith } from "../../steps.js";
import { RunControl } from "#renderer/features/workflows/components/RunControl.js";
import { OpenInReview, type ReviewOpener } from "./OpenInReview.js";
import { MissingTargetLine } from "#renderer/components/MissingTargetLine/MissingTargetLine.js";
import { useGoneSessionLine } from "#renderer/features/workflows/hooks/useGoneSessionLine.js";

/** What a run's header is drawn from, and where its links lead. */
export interface RunHeaderProps {
  readonly run: WorkflowRunReadResponse;
  /** The workflow's name, once it has been read. */
  readonly workflowName: string | undefined;
  /** The pinned version's number, once the version has been read; its chip waits for it. */
  readonly versionNumber: number | undefined;
  /** A step's node kind in the pinned version, which names the step; `undefined` until read. */
  readonly nodeKind: (nodeId: string) => string | undefined;
  /** A step's node name in the pinned version. */
  readonly nodeName: (nodeId: string) => string;
  readonly payerOf: (providerAccountId: string) => PayerReading;
  readonly bridge: PlatformBridge;
  readonly onOpenRun: (workflowRunId: string) => void;
  /** Open a session, unless the background service answers it no longer exists. */
  readonly onOpenSession: (
    sessionId: string,
    pressedControl: SessionPointerControl,
  ) => Promise<SessionPointerOutcome>;
  /** Open the session that started the run with its starting message in view. */
  readonly onOpenMessage: (
    sessionId: string,
    messageAnchorCursor: EventCursor | undefined,
    pressedControl: SessionPointerControl,
  ) => Promise<SessionPointerOutcome>;
  /** Open the workflow the run came from, unless the run's session no longer exists. */
  readonly onOpenWorkflow: (
    definitionId: string,
    pressedControl: SessionPointerControl,
  ) => Promise<SessionPointerOutcome>;
  /** Open Review on what the run changed between two of its snapshots. */
  readonly onOpenReview: ReviewOpener;
}

/**
 * A run's header: what happened and what it needs, the run's facts and links, its three
 * controls and `Open in Review` once it has finished, and while it is going, the live line
 * directly above the graph.
 */
export function RunHeader(props: RunHeaderProps): React.JSX.Element {
  const { run, bridge } = props;
  const clockLocale = useClockLocale();
  const workflowRunId = run.workflowRunId;
  const { review, startedBy, fixSessionId } = run;
  // The daemon starts the new run from this run's own version, input and mode.
  const rerun = useWorkflowCall(
    () => callDaemon(bridge, "workflow.runRerun", { workflowRunId }),
    (started) => {
      props.onOpenRun(started.workflowRunId);
    },
  );
  const cancel = useWorkflowCall(() => callDaemon(bridge, "workflow.runCancel", { workflowRunId }));
  const resume = useWorkflowCall(() => callDaemon(bridge, "workflow.runResume", { workflowRunId }));
  const isChained = run.chainRoot.runId !== workflowRunId;
  const isTicking = isGoing(run.status);
  // The day words move at midnight and a going run's time so far every second.
  const nowMs = useRunTimesNow({
    drawn: [run],
    isTicking,
    namesDays: true,
    isPartOfDayShown: false,
  });
  const lines = runHeaderLines(run, {
    nodeKind: props.nodeKind,
    nodeName: props.nodeName,
    workflowName: props.workflowName,
  });
  const liveLine = runLiveLine(run);
  const durationWords = runDurationUntil(run, isTicking, nowMs);
  const waiting = latestStepWith(run.steps, "waiting");

  return (
    <header className="meridian-workflow-run__header">
      <div className="meridian-workflow-run__lines">
        <span className="meridian-workflow-run__eyebrow">What happened</span>
        <h2 className="meridian-workflow-run__happened">
          <FigureSentence parts={lines.happened} />
        </h2>
        <span className="meridian-workflow-run__eyebrow">What it needs</span>
        <p className="meridian-workflow-run__needs">{lines.needs}</p>
      </div>
      <dl className="meridian-workflow-run__facts">
        <Fact term="Status">
          <RunStatusChip status={run.status} waitCause={waiting?.waitCause} />
        </Fact>
        <Fact term="Workflow">
          {props.workflowName}
          {props.versionNumber === undefined ? null : (
            <Chip label={`version v${formatCount(props.versionNumber)} pinned`} />
          )}
        </Fact>
        <Fact term="Started">
          <DayClockFigure at={run.startedAt} nowMs={nowMs} locale={clockLocale} />
        </Fact>
        {durationWords === undefined ? null : <Fact term="Duration">{durationWords}</Fact>}
        <Fact term="Trigger">{TRIGGER_KIND_WORDS[run.triggerKind]}</Fact>
        <Fact term="Started by">
          {startedByWords(run.startedBy)}
          {isChained ? (
            <>
              {" · "}
              <button
                type="button"
                className="meridian-workflow-run__link meridian-link-button"
                onClick={() => {
                  props.onOpenRun(run.chainRoot.runId);
                }}
              >
                {`Started by ${run.chainRoot.workflowName} · `}
                <DayClockFigure at={run.chainRoot.startedAt} nowMs={nowMs} locale={clockLocale} />
              </button>
            </>
          ) : null}
        </Fact>
        <Fact term="Cost">
          <FigureSentence parts={costWithPayer(run.cost, props.payerOf)} />
        </Fact>
      </dl>
      <div className="meridian-workflow-run__links">
        <SessionHeaderLink
          label="Open the workflow"
          pressedControl="run-open-workflow"
          onPress={() => props.onOpenWorkflow(run.definitionId, "run-open-workflow")}
        />
        {startedBy.kind === "parentWorkflow" ? (
          <HeaderLink
            label="Open the parent run"
            onPress={() => {
              props.onOpenRun(startedBy.parentWorkflowRunId);
            }}
          />
        ) : null}
        {startedBy.kind === "chat" ? (
          <SessionHeaderLink
            label="Open the message that started it"
            pressedControl="run-started-by-message"
            onPress={() =>
              props.onOpenMessage(
                startedBy.sessionId,
                startedBy.messageAnchorCursor,
                "run-started-by-message",
              )
            }
          />
        ) : null}
        {fixSessionId === undefined ? null : (
          <SessionHeaderLink
            label={fixSessionLinkWords(run, props.nodeName)}
            pressedControl="run-fix-session"
            onPress={() => props.onOpenSession(fixSessionId, "run-fix-session")}
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
            snapshots={review}
            pressedControl="run-open-review"
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
              <FigureSentence parts={part.words} />
              {part.at === undefined ? null : (
                <>
                  {" "}
                  <DayClockFigure at={part.at} nowMs={nowMs} locale={clockLocale} />
                </>
              )}
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
    <button
      type="button"
      className="meridian-workflow-run__link meridian-link-button"
      onClick={props.onPress}
    >
      {props.label}
    </button>
  );
}

/**
 * A header link into a session, or into a pane of one, which says `Session not found` on itself
 * when the session it points into is gone.
 */
function SessionHeaderLink(props: {
  readonly label: string;
  readonly pressedControl: SessionPointerControl;
  readonly onPress: () => Promise<SessionPointerOutcome>;
}): React.JSX.Element {
  const goneSessionLine = useGoneSessionLine(props.pressedControl);
  return (
    <span className="meridian-workflow-run__control" ref={goneSessionLine.controlRef}>
      <HeaderLink
        label={props.label}
        onPress={() => {
          goneSessionLine.follow(props.onPress());
        }}
      />
      {goneSessionLine.line === undefined ? null : <MissingTargetLine {...goneSessionLine.line} />}
    </span>
  );
}

/**
 * The link to the session fixing a failed step, naming the step, which is the run's latest
 * failure: a fix session is opened from a failed step, and its record stays on the run.
 */
function fixSessionLinkWords(
  run: WorkflowRunReadResponse,
  nodeName: (nodeId: string) => string,
): string {
  const fixed = latestStepWith(run.steps, "failed");
  return fixed === undefined
    ? "Open the fix session"
    : `Open the session fixing ${nodeName(fixed.nodeId)}`;
}

/**
 * How long the run took, or while it is going how long it has taken so far, the app's own span
 * between the daemon's instants or to the window's clock; `undefined` for a failed run parked on
 * its step, which has neither ended nor kept going.
 */
function runDurationUntil(
  run: WorkflowRunReadResponse,
  isTicking: boolean,
  nowMs: number,
): string | undefined {
  if (isTicking) {
    return runDurationWords(run.startedAt, nowMs);
  }
  const finished = run.finishedAt === undefined ? undefined : parseInstant(run.finishedAt);
  return finished?.kind === "instant"
    ? runDurationWords(run.startedAt, finished.epochMilliseconds)
    : undefined;
}
