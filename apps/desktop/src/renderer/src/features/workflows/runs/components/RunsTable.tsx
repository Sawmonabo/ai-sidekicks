import { useCallback, useState } from "react";

import type { WorkflowRunSummary } from "@ai-sidekicks/contracts/workflow/run/records";

import { Chip } from "@renderer/components/Chip/Chip.js";
import { formatCount, formatDayClock, formatUnitDuration } from "@renderer/lib/wire-figures.js";
import { callDaemon } from "@renderer/services/daemon/daemon-reply.js";
import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { RunStatusChip } from "../../components/RunStatusChip.js";
import { useWorkflowAct, type WorkflowActState } from "../../hooks/useWorkflowAct.js";
import { costWithPayer } from "../../run-cost.js";
import { runDurationWords } from "../../run-duration.js";
import { RunControl } from "../../components/RunControl.js";
import { isGoing } from "../../run-controls.js";
import { TRIGGER_KIND_WORDS, startedByWords } from "../../workflow-words.js";
import { useInlineConfirm } from "../hooks/useInlineConfirm.js";
import { useInViewMarks } from "../hooks/useInViewMarks.js";
import { RunLiveDot } from "./RunLiveDot.js";
import { ActionButton } from "../../components/ActionButton.js";

/** What the runs table is drawn from and where a row leads. */
export interface RunsTableProps {
  readonly runs: readonly WorkflowRunSummary[];
  readonly accountLabel: (providerAccountId: string) => string | undefined;
  readonly bridge: PlatformBridge;
  readonly onOpenRun: (workflowRunId: string) => void;
  /** The instant a going run's time so far is counted to and its start's day is named from. */
  readonly nowMs: number;
}

/**
 * The runs table, newest first, one row per run, each reading the workflow's name, the status
 * chip, the trigger, who or what started it, when, how long it took, how many steps it ran and
 * what it cost with the account that paid, and one act, `Delete run`, beside the `Keep` mark of a
 * kept run. A going run's step cell says where it is — `4 of 9 · run tests` — and its time cell
 * counts the time so far, and both go back to the finished figures when it ends. A run parked on a
 * spent account names the instant it resumes itself, or that none is armed.
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
          <th scope="col">
            <span className="meridian-visually-hidden">Act</span>
          </th>
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
  const [isConfirming, setIsConfirming] = useState(false);
  const closeConfirm = useCallback(() => {
    setIsConfirming(false);
  }, []);
  const remove = useWorkflowAct(() =>
    callDaemon(props.bridge, "workflow.runDelete", { workflowRunId: run.workflowRunId }),
  );
  // Once a delete is sent the confirm takes no second press; the row goes when the removal is
  // heard and the list is read again.
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
                : `parked · resumes ${formatDayClock(run.resumeAt, props.nowMs)}`}
            </span>
          ) : null}
        </span>
      </td>
      <td>{TRIGGER_KIND_WORDS[run.triggerKind]}</td>
      <td>{startedByWords(run.startedBy)}</td>
      <td>{formatDayClock(run.startedAt, props.nowMs)}</td>
      <td>
        {run.durationMs === undefined
          ? runDurationWords(run.startedAt, props.nowMs)
          : formatUnitDuration(run.durationMs)}
      </td>
      <td>
        {run.liveStep === undefined ? formatCount(run.stepCount) : liveStepWords(run.liveStep)}
      </td>
      <td>{costWithPayer(run.cost, props.accountLabel)}</td>
      <td>
        {run.keep ? <Chip label="Keep" /> : null}
        {isConfirming ? (
          <DeleteRunConfirm
            workflowName={run.definitionName}
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
            availability={
              isGoing(run.status)
                ? { kind: "refused", reason: "Cancel it first." }
                : { kind: "allowed" }
            }
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
 * `Delete run`'s confirm, asked once in place of the act: it names what goes — the run's steps,
 * their data, and any snapshot folder and repository pins holding what it changed — and Escape
 * closes it as `Cancel` does.
 */
function DeleteRunConfirm(props: {
  readonly workflowName: string;
  readonly isSent: boolean;
  readonly act: WorkflowActState<unknown>;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}): React.JSX.Element {
  const confirm = useInlineConfirm(props.onCancel);
  return (
    <div
      ref={confirm.ref}
      className="meridian-workflows-runs__confirm"
      role="group"
      aria-label="Delete this run"
      onKeyDown={confirm.onKeyDown}
    >
      <span>
        {`Delete this run of ${props.workflowName}? Its steps and their data go too, and any ` +
          "snapshots it pinned: its snapshot folder and their pins in the repository. " +
          "This cannot be undone."}
      </span>
      <ActionButton disabled={props.isSent} onClick={props.onCancel}>
        Cancel
      </ActionButton>
      <RunControl
        label="Delete run"
        availability={{ kind: "allowed" }}
        act={props.act}
        onPress={props.onConfirm}
      />
    </div>
  );
}

/** Where a going run is: `4 of 9 · Review one PR`. */
function liveStepWords(liveStep: NonNullable<WorkflowRunSummary["liveStep"]>): string {
  return `${formatCount(liveStep.index)} of ${formatCount(liveStep.total)} · ${liveStep.nodeName}`;
}

/** The act state a sent delete holds its confirm in, from the send until the row goes. */
const DELETE_SENT: WorkflowActState<unknown> = { kind: "sending" };
