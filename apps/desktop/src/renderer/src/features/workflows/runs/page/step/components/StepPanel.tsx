import { Tabs } from "@base-ui/react/tabs";
import { useState } from "react";

import type { WorkflowRunSnapshotPoint } from "@ai-sidekicks/contracts/gitflow/local";
import type { WorkflowDocument } from "@ai-sidekicks/contracts/workflow/definition/document";
import type { WorkflowStep } from "@ai-sidekicks/contracts/workflow/run/step/record";
import type { WorkflowRunReadResponse } from "@ai-sidekicks/contracts/workflow/run/records";

import { Chip } from "#renderer/components/Chip/Chip.js";
import { useAnnounce } from "#renderer/hooks/announce/useAnnounce.js";
import { useReadScope } from "#renderer/hooks/useReadScope.js";
import { useOverlayScrollbar } from "#renderer/hooks/useOverlayScrollbar.js";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { formatCount } from "#renderer/lib/wire/figures.js";
import { readWorkflowPayloadItems } from "#renderer/services/artifacts/workflow-payload-items.js";
import { callDaemon, type DaemonReply } from "#renderer/services/daemon/reply.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { useWorkflowCall } from "#renderer/features/workflows/hooks/useWorkflowCall.js";
import { costWithPayer, type PayerReading } from "#renderer/features/workflows/runs/cost.js";
import { STEP_STATUS_WORDS } from "#renderer/features/workflows/words.js";
import {
  retryAvailability,
  type RunControlAvailability,
} from "#renderer/features/workflows/runs/controls.js";
import {
  isPersonWaitCause,
  nodePasses,
  type NodePass,
} from "#renderer/features/workflows/runs/steps.js";
import type { StepAddress } from "../../hooks/useRunPage.js";
import { stepKeyText } from "../key-text.js";
import { PIN_CARRIES_FILE_REFUSAL, pinAvailability, pinnedItemsOf } from "../pin.js";
import { RunControl } from "#renderer/features/workflows/components/RunControl.js";
import { StepBlocker } from "./StepBlocker.js";
import { StepError } from "./StepError.js";
import type { StepPayloadView } from "./StepPayload.js";
import { StepPayloadTab } from "./StepPayloadTab.js";
import { StepRecordTab } from "./StepRecordTab.js";
import { ActionButton } from "#renderer/features/workflows/components/ActionButton.js";

/** The step panel's five tabs, in the order they stand. */
const STEP_TABS = ["input", "output", "logs", "cost", "error"] as const;

/** One of the step panel's tabs. */
type StepTab = (typeof STEP_TABS)[number];

const STEP_TAB_LABELS: Readonly<Record<StepTab, string>> = {
  input: "Input",
  output: "Output",
  logs: "Logs",
  cost: "Cost",
  error: "Error",
};

/** What the step panel draws one node's steps from, and where its acts lead. */
export interface StepPanelProps {
  readonly run: WorkflowRunReadResponse;
  /**
   * The version the run pinned, once read: it names the node's outputs for
   * `Pin this output as builder test data`.
   */
  readonly document: WorkflowDocument | undefined;
  readonly nodeId: string;
  /** A step's node kind in the pinned version, `undefined` until the version is read. */
  readonly nodeKind: (nodeId: string) => string | undefined;
  readonly nodeName: (nodeId: string) => string;
  readonly payerOf: (providerAccountId: string) => PayerReading;
  readonly bridge: PlatformBridge;
  /** The instant a receipt's day is counted from. */
  readonly nowMs: number;
  /** The receipts this sitting's answers left, by step. */
  readonly receipts: ReadonlyMap<string, string>;
  /** Called with the receipt once the daemon has taken an answer to a step. */
  readonly onAnswered: (step: StepAddress, receipt: string) => void;
  readonly onOpenRun: (workflowRunId: string) => void;
  readonly onOpenReview: (from: WorkflowRunSnapshotPoint, to: WorkflowRunSnapshotPoint) => void;
  readonly onOpenSession: (sessionId: string) => void;
  readonly onClose: () => void;
}

/**
 * The step panel beside the graph: one of the picked node's steps — the latest until a person
 * picks another pass or attempt — how to answer it where it waits on a person, the run it called
 * where it called one, its input, output, logs, cost and error, each in a Table and a JSON view,
 * and the acts on it: `Retry from this step`, the run's Keep mark,
 * `Pin this output as builder test data` and, on a failed step, `Fix in a fresh session`. It opens
 * on Output, or on Error where the step failed. A node the run never reached reads `Not reached`
 * on its chip, and its acts keep their place, refusing in words.
 */
export function StepPanel(props: StepPanelProps): React.JSX.Element {
  const { run, nodeId } = props;
  const passes = nodePasses(run.steps, nodeId);
  const [pickedExecution, setPickedExecution] = useState<number | undefined>(undefined);
  const picked =
    passes.find((entry) => entry.step.executionIndex === pickedExecution) ?? passes.at(-1);
  const step = picked?.step;
  const name = props.nodeName(nodeId);
  const panelScrollbarRef = useOverlayScrollbar<HTMLDivElement>();
  return (
    <aside className="meridian-workflow-step" aria-label="Step panel">
      <div className="meridian-workflow-step__scroller" ref={panelScrollbarRef}>
        <header className="meridian-workflow-step__head">
          <h3 className="meridian-workflow-step__name">{name}</h3>
          {step === undefined ? <Chip label="Not reached" /> : <StepStateChip step={step} />}
          {passes.length > 1 && picked !== undefined ? (
            <select
              className="meridian-workflow-step__execution"
              aria-label="Execution"
              value={picked.step.executionIndex}
              onChange={(event) => {
                setPickedExecution(Number(event.currentTarget.value));
              }}
            >
              {passes.map((entry) => (
                <option key={entry.step.executionIndex} value={entry.step.executionIndex}>
                  {executionWords(entry, passes)}
                </option>
              ))}
            </select>
          ) : step === undefined || step.attempt === 1 ? null : (
            <span className="meridian-workflow-step__attempt">
              {`Attempt ${formatCount(step.attempt)}`}
            </span>
          )}
          <ActionButton aria-label="Close step panel" onClick={props.onClose}>
            Close
          </ActionButton>
        </header>
        {step === undefined ? (
          <StepActs {...props} step={undefined} />
        ) : (
          <StepBody {...props} step={step} key={stepKeyText(step)} />
        )}
      </div>
    </aside>
  );
}

function StepBody(props: StepPanelProps & { readonly step: WorkflowStep }): React.JSX.Element {
  const { run, step, bridge } = props;
  const [tab, setTab] = useState<StepTab>(step.status === "failed" ? "error" : "output");
  const [view, setView] = useState<StepPayloadView>("table");
  const sources = sourceWords(run, step, props.nodeName);
  const childRunId = step.childWorkflowRunId;
  const label = `${STEP_TAB_LABELS[tab]} of ${props.nodeName(step.nodeId)}`;

  return (
    <>
      {sources.map((source, index) => (
        <p key={index} className="meridian-workflow-step__note">
          {source}
        </p>
      ))}
      {childRunId === undefined ? null : (
        <button
          type="button"
          className="meridian-workflow-run__link"
          onClick={() => {
            props.onOpenRun(childRunId);
          }}
        >
          Open the child run
        </button>
      )}
      <StepBlocker
        run={run}
        step={step}
        nodeKind={props.nodeKind(step.nodeId)}
        receipt={props.receipts.get(stepKeyText(step))}
        nowMs={props.nowMs}
        bridge={bridge}
        onAnswered={(receipt) => {
          props.onAnswered(step, receipt);
        }}
        onOpenReview={props.onOpenReview}
      />
      <Tabs.Root
        value={tab}
        onValueChange={(next: StepTab) => {
          setTab(next);
        }}
      >
        <Tabs.List className="meridian-workflow-step__tabs" aria-label="Step data">
          {STEP_TABS.map((candidate) => (
            <Tabs.Tab key={candidate} value={candidate} className="meridian-workflow-step__tab">
              {STEP_TAB_LABELS[candidate]}
            </Tabs.Tab>
          ))}
        </Tabs.List>
        <Tabs.Panel value={tab} className="meridian-workflow-step__tab-body">
          <ViewToggle view={view} onChange={setView} />
          {tab === "output" && step.advisories !== undefined && step.advisories.length > 0 ? (
            <ul className="meridian-workflow-step__advisories" aria-label="Advisories">
              {step.advisories.map((advisory, index) => (
                <li key={index}>{advisory}</li>
              ))}
            </ul>
          ) : null}
          {tab === "input" || tab === "output" || tab === "logs" ? (
            <StepPayloadTab
              key={tab}
              bridge={bridge}
              step={step}
              which={tab === "logs" ? "log" : tab}
              view={view}
              label={label}
            />
          ) : null}
          {tab === "cost" ? (
            <StepRecordTab stored={step.cost} view={view} label={label}>
              <p className="meridian-workflow-step__note">
                {costWithPayer(step.cost, props.payerOf)}
              </p>
            </StepRecordTab>
          ) : null}
          {tab === "error" ? (
            <StepRecordTab stored={step.error} view={view} label={label}>
              <StepError step={step} />
            </StepRecordTab>
          ) : null}
        </Tabs.Panel>
      </Tabs.Root>
      <StepActs {...props} step={step} />
    </>
  );
}

/**
 * The acts on a node's step, standing whatever the run's state and whether the node ran:
 * `Retry from this step`, the run's Keep mark, `Pin this output as builder test data` and, on a
 * failed step, `Fix in a fresh session`. Each one the state does not allow refuses in words, and a
 * press the daemon refuses shows its words in place. A pin that lands is announced, and its label
 * stays, since a pin can be repeated. A pin still reading its artifact when the panel closes stops
 * there and sends nothing.
 */
function StepActs(props: StepPanelProps & { readonly step: WorkflowStep | undefined }) {
  const { run, step, bridge } = props;
  const retry = useWorkflowCall(
    (failed: WorkflowStep) =>
      callDaemon(bridge, "workflow.runRetry", {
        workflowRunId: run.workflowRunId,
        fromNodeId: failed.nodeId,
      }),
    (retried) => {
      props.onOpenRun(retried.workflowRunId);
    },
  );
  const fix = useWorkflowCall(
    (failed: WorkflowStep) =>
      callDaemon(bridge, "workflow.fixSessionCreate", {
        workflowRunId: failed.workflowRunId,
        nodeId: failed.nodeId,
        executionIndex: failed.executionIndex,
      }),
    (created) => {
      props.onOpenSession(created.sessionId);
    },
  );
  const keep = useWorkflowCall((next: boolean) =>
    callDaemon(bridge, "workflow.runKeepSet", { workflowRunId: run.workflowRunId, keep: next }),
  );
  const announce = useAnnounce();
  const pinScope = useReadScope(bridge, `${run.workflowRunId}/${props.nodeId}/pin`);
  const pin = useWorkflowCall(
    (ran: WorkflowStep) => pinOutput(bridge, run, ran, pinScope.openRound().signal),
    () => {
      announce(`${props.nodeName(props.nodeId)} output pinned onto the builder`);
    },
  );
  const fixSessionId = run.fixSessionId;
  return (
    <div className="meridian-workflow-step__acts">
      <RunControl
        label="Retry from this step"
        availability={step === undefined ? RETRY_NOT_REACHED : retryAvailability(run, step)}
        act={retry.state}
        onPress={() => {
          if (step !== undefined) {
            retry.take(step);
          }
        }}
      />
      <span className="meridian-workflow-run__control">
        <label className="meridian-workflow-run__keep">
          <input
            type="checkbox"
            checked={run.keep}
            disabled={keep.state.kind === "sending"}
            onChange={(event) => {
              keep.take(event.currentTarget.checked);
            }}
          />
          Keep
        </label>
        {keep.state.kind === "refused" ? (
          <InlineRefusal code={keep.state.refusal.code} detail={keep.state.refusal.detail} />
        ) : null}
      </span>
      <RunControl
        label="Pin this output as builder test data"
        availability={step === undefined ? PIN_NOT_REACHED : pinAvailability(props.document, step)}
        act={pin.state}
        onPress={() => {
          if (step !== undefined) {
            pin.take(step);
          }
        }}
      />
      {step?.status === "failed" ? (
        <RunControl
          label="Fix in a fresh session"
          availability={{ kind: "allowed" }}
          act={fix.state}
          onPress={() => {
            // One fix session per run: once it exists, the press opens it again.
            if (fixSessionId === undefined) {
              fix.take(step);
            } else {
              props.onOpenSession(fixSessionId);
            }
          }}
        />
      ) : null}
    </div>
  );
}

/** What the step's acts refuse with on a node the run never reached. */
const RETRY_NOT_REACHED: RunControlAvailability = {
  kind: "refused",
  reason: "Retry · this step was not reached",
};
const PIN_NOT_REACHED: RunControlAvailability = {
  kind: "refused",
  reason: "Pin · this step was not reached",
};

function ViewToggle(props: {
  readonly view: StepPayloadView;
  readonly onChange: (view: StepPayloadView) => void;
}): React.JSX.Element {
  return (
    <div className="meridian-workflow-step__views" role="group" aria-label="View">
      {(["table", "json"] as const).map((candidate) => (
        <button
          key={candidate}
          type="button"
          aria-pressed={props.view === candidate}
          className="meridian-workflow-step__view"
          onClick={() => {
            props.onChange(candidate);
          }}
        >
          {candidate === "table" ? "Table" : "JSON"}
        </button>
      ))}
    </div>
  );
}

function StepStateChip(props: { readonly step: WorkflowStep }): React.JSX.Element {
  const { step } = props;
  const isPersonWait = step.status === "waiting" && isPersonWaitCause(step.waitCause);
  return (
    <Chip
      tone={
        step.status === "failed"
          ? "failure"
          : isPersonWait
            ? "attention"
            : step.status === "running"
              ? "accent"
              : "neutral"
      }
      label={STEP_STATUS_WORDS[step.status]}
    />
  );
}

/** A pass or attempt as the execution picker names it: `Run 2 · attempt 3`. */
function executionWords(entry: NodePass, passes: readonly NodePass[]): string {
  const attempt = formatCount(entry.step.attempt);
  if (!passes.some((candidate) => candidate.pass > 1)) {
    return `Attempt ${attempt}`;
  }
  const run = `Run ${formatCount(entry.pass)}`;
  return entry.step.attempt === 1 ? run : `${run} · attempt ${attempt}`;
}

/**
 * The executed source edge of each input: the step that fed it, the output it came from, the
 * pass of the source's node where it ran more than one, and the execution, so a step fed by the
 * third pass of a loop says `run 3`.
 */
function sourceWords(
  run: WorkflowRunReadResponse,
  step: WorkflowStep,
  nodeName: (nodeId: string) => string,
): string[] {
  return step.source.flatMap((source) => {
    if (source === null) {
      return [];
    }
    const passes = nodePasses(run.steps, source.nodeId);
    const fed = passes.find((entry) => entry.step.executionIndex === source.executionIndex);
    const pass =
      fed !== undefined && passes.some((entry) => entry.pass > 1)
        ? `, run ${formatCount(fed.pass)}`
        : "";
    return [
      `Fed by ${nodeName(source.nodeId)} output ${formatCount(source.outputIndex)}${pass} ` +
        `(execution ${formatCount(source.executionIndex)})`,
    ];
  });
}

/**
 * Pin the step's output onto its node as builder test data: its items as stored, read from its
 * artifact where it was kept as one, refused when any of them carries a file. A read `signal`
 * ended stops the pin before anything is sent.
 */
async function pinOutput(
  bridge: PlatformBridge,
  run: WorkflowRunReadResponse,
  step: WorkflowStep,
  signal: AbortSignal,
): Promise<DaemonReply<unknown>> {
  const { outputRef } = step;
  const read =
    outputRef.kind === "inline"
      ? ({ status: "served", value: outputRef.items } as const)
      : await readWorkflowPayloadItems(bridge, outputRef.artifactId, signal);
  if (read.status === "refused") {
    return read;
  }
  const items = pinnedItemsOf(read.value);
  if (items === undefined) {
    return { status: "refused", refusal: PIN_CARRIES_FILE_REFUSAL };
  }
  return callDaemon(bridge, "workflow.pinDataSet", {
    definitionId: run.definitionId,
    nodeId: step.nodeId,
    items,
  });
}
