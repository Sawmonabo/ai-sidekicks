import { useCallback, useState } from "react";

import type { WorkflowRunSummary } from "@ai-sidekicks/contracts/workflow/run/records";

import { Chip } from "#renderer/components/Chip/Chip.js";
import { useInlineConfirm } from "#renderer/hooks/useInlineConfirm.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import {
  formatCount,
  formatDayClock,
  formatUnitDuration,
  formatZonedDateTime,
} from "#renderer/lib/wire/figures.js";
import { callDaemon } from "#renderer/services/daemon/reply.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { useClockLocale } from "#renderer/services/platform/hooks/useClockLocale.js";
import { RunStatusChip } from "../../components/RunStatusChip.js";
import { useWorkflowCall, type WorkflowCallState } from "../../hooks/useWorkflowCall.js";
import { costWithPayer, type PayerReading } from "../cost.js";
import { runDurationWords } from "../duration.js";
import { RunControl } from "../../components/RunControl.js";
import { deleteRunAvailability, isGoing } from "../controls.js";
import { TRIGGER_KIND_WORDS, startedByWords } from "../../words.js";
import { useInViewMarks } from "../hooks/useInViewMarks.js";
import { RunLiveDot } from "./RunLiveDot.js";
import { ActionButton } from "../../components/ActionButton.js";

/** What the runs table is drawn from and where a row leads. */
export interface RunsTableProps {
  readonly runs: readonly WorkflowRunSummary[];
  readonly payerOf: (providerAccountId: string) => PayerReading;
  readonly bridge: PlatformBridge;
  readonly onOpenRun: (workflowRunId: string) => void;
  /**
   * Called once a delete is served, so the list is read again and the row goes even while the
   * workflow stream that would have said so is down.
   */
  readonly onRunDeleted: () => void;
  /** The instant a going run's time so far is counted to and its start's day is named from. */
  readonly nowMs: number;
}

/**
 * The runs table, newest first, one row per run, each reading the workflow's name, the status
 * chip, the trigger, who or what started it, when, how long it took, how many steps it ran and
 * what it cost with the account that paid, and one act, `Delete run`, beside the `Keep` mark of a
 * kept run. A going run's step cell says where it is — `4 of 9 · run tests` — and its time cell
 * counts the time so far, and both go back to the finished figures when it ends; a failed run
 * parked on its failed step draws no time. A run parked on a spent account names the instant it
 * resumes itself, or that none is armed.
 */
export function RunsTable(props: RunsTableProps): React.JSX.Element {
  // One observer holds every going row's live dot still while it is scrolled out of view.
  const markInView = useInViewMarks();
  return (
    <table className="meridian-workflows-runs__table">
      <thead>
        <tr>
          <th scope="col">Workflow</th>
          <th scope="col">Status</th>
          <th scope="col">Trigger</th>
          <th scope="col">Started by</th>
          <th scope="col">Started at</th>
          <th scope="col">Duration</th>
          <th scope="col">Steps</th>
          <th scope="col">Cost</th>
          {/* The row's control column carries no heading; each control names its own act. */}
          <td />
        </tr>
      </thead>
      <tbody>
        {props.runs.map((run) => (
          <RunRow key={run.workflowRunId} run={run} markInView={markInView} {...props} />
        ))}
      </tbody>
    </table>
  );
}

function RunRow(
  props: RunsTableProps & {
    readonly run: WorkflowRunSummary;
    readonly markInView: (element: HTMLElement | null) => (() => void) | undefined;
  },
): React.JSX.Element {
  const { run } = props;
  const clockLocale = useClockLocale();
  const [isConfirming, setIsConfirming] = useState(false);
  const closeConfirm = useCallback(() => {
    setIsConfirming(false);
  }, []);
  const remove = useWorkflowCall(
    () => callDaemon(props.bridge, "workflow.runDelete", { workflowRunId: run.workflowRunId }),
    props.onRunDeleted,
  );
  // Once a delete is sent the confirm takes no second press; the row goes when the list is read
  // again after the delete is served.
  const isDeleteSent = remove.state.kind === "sending" || remove.state.kind === "done";
  return (
    <tr>
      <th scope="row">
        <button
          type="button"
          className="meridian-workflow-run__link"
          onClick={() => {
            props.onOpenRun(run.workflowRunId);
          }}
        >
          {run.definitionName}
        </button>
      </th>
      <td>
        <span className="meridian-workflows-runs__status">
          {isGoing(run.status) ? <RunLiveDot markInView={props.markInView} /> : null}
          <RunStatusChip status={run.status} waitCause={run.waitCause} />
          {run.waitCause === "account" ? (
            <span className="meridian-workflows-runs__park">
              {run.resumeAt === undefined
                ? "parked · awaiting resume"
                : `parked · resumes ${formatDayClock(run.resumeAt, props.nowMs, clockLocale)}`}
            </span>
          ) : null}
        </span>
      </td>
      <td>{TRIGGER_KIND_WORDS[run.triggerKind]}</td>
      <td>{startedByWords(run.startedBy)}</td>
      <td>
        <WireFigure
          value={formatDayClock(run.startedAt, props.nowMs, clockLocale)}
          title={formatZonedDateTime(run.startedAt, clockLocale)}
        />
      </td>
      <td>{rowDurationWords(run, props.nowMs)}</td>
      <td>
        {run.liveStep === undefined ? formatCount(run.stepCount) : liveStepWords(run.liveStep)}
      </td>
      <td>{costWithPayer(run.cost, props.payerOf)}</td>
      <td>
        {run.keep ? <Chip label="Keep" /> : null}
        {isConfirming ? (
          <DeleteRunConfirm
            workflowName={run.definitionName}
            startedAt={formatDayClock(run.startedAt, props.nowMs, clockLocale)}
            isSent={isDeleteSent}
            act={isDeleteSent ? DELETE_SENT : remove.state}
            onCancel={closeConfirm}
            onConfirm={() => {
              remove.take(undefined);
            }}
          />
        ) : (
          <RunControl
            label="Delete run"
            availability={deleteRunAvailability(run)}
            act={{ kind: "idle" }}
            onPress={() => {
              setIsConfirming(true);
            }}
          />
        )}
      </td>
    </tr>
  );
}

/**
 * `Delete run`'s confirm, asked once in place of the act: it names the run and what goes, says
 * that the files it saved on purpose stay, and Escape closes it as `Cancel` does.
 */
function DeleteRunConfirm(props: {
  readonly workflowName: string;
  /** When the run started, as its row reads it. */
  readonly startedAt: string;
  readonly isSent: boolean;
  readonly act: WorkflowCallState<unknown>;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}): React.JSX.Element {
  const confirm = useInlineConfirm(props.onCancel);
  return (
    <div
      ref={confirm.ref}
      className="meridian-workflows-runs__confirm"
      role="group"
      aria-label="Delete this run?"
      onKeyDown={confirm.onKeyDown}
    >
      <span>
        {`${props.workflowName} · ${props.startedAt}. The row and its step data go. Files it ` +
          "saved on purpose stay. This cannot be undone."}
      </span>
      <ActionButton disabled={props.isSent} onClick={props.onCancel}>
        Cancel
      </ActionButton>
      <RunControl
        label="Delete run"
        availability={{ kind: "allowed" }}
        act={props.act}
        className="meridian-action-button--destructive"
        onPress={props.onConfirm}
      />
    </div>
  );
}

/** Where a going run is: `4 of 9 · Review one PR`. */
// How long the run took, or while it is going how long so far; nothing for a failed run parked on
// its failed step, which has neither ended nor kept going.
function rowDurationWords(run: WorkflowRunSummary, nowMs: number): string | undefined {
  if (run.durationMs !== undefined) {
    return formatUnitDuration(run.durationMs);
  }
  return isGoing(run.status) ? runDurationWords(run.startedAt, nowMs) : undefined;
}

function liveStepWords(liveStep: NonNullable<WorkflowRunSummary["liveStep"]>): string {
  return `${formatCount(liveStep.index)} of ${formatCount(liveStep.total)} · ${liveStep.nodeName}`;
}

/** The act state a sent delete holds its confirm in, from the send until the row goes. */
const DELETE_SENT: WorkflowCallState<unknown> = { kind: "sending" };
