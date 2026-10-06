// The step panel over one node's step records: every pass and attempt of the node is reachable
// and a retry stays in the pass it retried; the output reads the step's advisories above it, the
// error reads its code in words with its reason, then its process's exit code and last lines,
// and the cost and the error read as stored in the JSON view; `Pin this output as builder test
// data` sends the output as stored, read from its artifact where it was kept as one, announces the
// pin and keeps its label, and refuses output that carries a file or a node with more than one
// main output; a node the run never reached reads `Not reached` and its acts keep their place,
// each refusing in its own words; a refused Keep says so in the daemon's words; and
// `Fix in a fresh session` opens the run's fix session again once there is one.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ArtifactId } from "@ai-sidekicks/contracts/artifacts/id";
import type {
  WorkflowBinaryRef,
  WorkflowDocument,
  WorkflowItem,
} from "@ai-sidekicks/contracts/workflow/definition/document";
import { WORKFLOW_STEP_THREAD_FAILED_CODE } from "@ai-sidekicks/contracts/workflow/run/failures";
import { type WorkflowStep } from "@ai-sidekicks/contracts/workflow/run/step/record";
import type { WorkflowRunReadResponse } from "@ai-sidekicks/contracts/workflow/run/records";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { bridgeWrapper } from "#test/helpers/app/frame-fixtures.js";
import { inlinePayloadRead } from "#test/helpers/artifact-list-readers.js";
import { bridgeAnswering, type RecordedDaemonCall } from "#test/helpers/fixture/bridge.js";
import {
  WORKFLOW_DEFINITION_RECORDS,
  WORKFLOW_FIXTURE_NOW_MS,
  WORKFLOW_PAYING_ACCOUNT,
  WORKFLOW_RUN_IDS,
  WORKFLOW_RUN_RECORDS,
} from "#fixtures/data/workflow/run/records.js";
import { StepPanel } from "./StepPanel.js";

const OUTPUT_ARTIFACT = "019b7a20-0280-75e5-8510-ada11a5a5999" as ArtifactId;

const FILE_REF: WorkflowBinaryRef = {
  artifactId: "0190f5c2-7d3e-7a10-9b2c-3d4e5f60718a" as ArtifactId,
  mimeType: "text/plain",
  fileName: "build-17.log",
  size: 14_336,
};

function fixtureRun(workflowRunId: string): WorkflowRunReadResponse {
  const record = WORKFLOW_RUN_RECORDS.find((run) => run.read.workflowRunId === workflowRunId);
  if (record === undefined) {
    throw new Error(`the fixture daemon holds no run ${workflowRunId}`);
  }
  return record.read;
}

/** The failed run's summary step, as one record of `node` with the given members. */
function summaryRecord(run: WorkflowRunReadResponse, members: Partial<WorkflowStep>): WorkflowStep {
  const summary = run.steps.find((step) => step.nodeId === "summary");
  if (summary === undefined) {
    throw new Error("the fixture's failed run has no summary step");
  }
  const { error: _error, ...withoutError } = summary;
  return { ...withoutError, ...members };
}

/** The panel over `nodeId`; every payload read answers empty, every other call as the fixture. */
function renderPanel(
  run: WorkflowRunReadResponse,
  options: {
    readonly document?: WorkflowDocument;
    readonly artifactText?: string;
    readonly keepRefusal?: Error;
    readonly onOpenSession?: (sessionId: string) => void;
  } = {},
): readonly RecordedDaemonCall[] {
  const { bridge, calls } = bridgeAnswering(async (call, passThrough) => {
    if (call.method === "workflow.stepRead") {
      const { nodeId, executionIndex, which } = call.params as Record<string, unknown>;
      return { nodeId, executionIndex, which, payload: { kind: "inline", items: [] } };
    }
    if (call.method === "workflow.runKeepSet" && options.keepRefusal !== undefined) {
      throw options.keepRefusal;
    }
    if (call.method === "artifact.read" && options.artifactText !== undefined) {
      return inlinePayloadRead(OUTPUT_ARTIFACT, options.artifactText);
    }
    return passThrough();
  });
  render(
    <LiveAnnouncerProvider>
      <StepPanel
        run={run}
        document={options.document}
        nodeId="summary"
        nodeKind={() => undefined}
        nodeName={(nodeId) => nodeId}
        accountLabel={() => undefined}
        bridge={bridge}
        nowMs={WORKFLOW_FIXTURE_NOW_MS}
        receipts={new Map()}
        onAnswered={() => undefined}
        onOpenRun={() => undefined}
        onOpenReview={() => undefined}
        onOpenSession={options.onOpenSession ?? (() => undefined)}
        onClose={() => undefined}
      />
    </LiveAnnouncerProvider>,
    { wrapper: bridgeWrapper(bridge) },
  );
  return calls;
}

describe("the step panel", () => {
  it("reaches every pass and attempt of a node, a retry staying in the pass it retried", () => {
    const failed = fixtureRun(WORKFLOW_RUN_IDS.failed);
    const others = failed.steps.filter((step) => step.nodeId !== "summary");
    const run: WorkflowRunReadResponse = {
      ...failed,
      steps: [
        ...others,
        summaryRecord(failed, {
          executionIndex: 2,
          attempt: 1,
          status: "failed",
          error: { message: "The summary came back empty." },
        }),
        summaryRecord(failed, {
          executionIndex: 3,
          attempt: 2,
          status: "failed",
          error: { message: "The summary came back empty twice.", itemIndex: 1 },
        }),
        summaryRecord(failed, { executionIndex: 4, attempt: 1, status: "succeeded" }),
      ],
    };
    renderPanel(run);

    const picker = screen.getByRole("combobox", { name: "Execution" });
    expect(
      Array.from((picker as HTMLSelectElement).options, (option) => option.text),
    ).toStrictEqual(["Run 1", "Run 1 · attempt 2", "Run 2"]);
    // The latest record opens first, on its output.
    expect((picker as HTMLSelectElement).value).toBe("4");
    expect(screen.getByRole("tab", { name: "Output" }).getAttribute("aria-selected")).toBe("true");

    fireEvent.change(picker, { target: { value: "3" } });
    expect(screen.getByRole("tab", { name: "Error" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Item 1")).toBeDefined();
    expect(screen.getByText("The summary came back empty twice.")).toBeDefined();
  });

  it("reads advisories over the output, the exit under the error, and records as stored", () => {
    const failed = fixtureRun(WORKFLOW_RUN_IDS.failed);
    const error = {
      message: "The suite exited with failures.",
      itemIndex: 0,
      code: WORKFLOW_STEP_THREAD_FAILED_CODE,
      details: { reason: "out_of_memory" },
    };
    const cost = { usdMicros: 1_800, providerAccountId: WORKFLOW_PAYING_ACCOUNT };
    const run: WorkflowRunReadResponse = {
      ...failed,
      steps: [
        summaryRecord(failed, {
          status: "failed",
          attempt: 1,
          error,
          processExit: { exitCode: 1, outputTail: "2 of 40 tests failed" },
          cost,
          advisories: ["The `skipped` branch is not wired, so 2 items were dropped."],
        }),
      ],
    };
    renderPanel(run);

    // A failed step opens on Error: its code in words with its reason, then its process's exit
    // code and last lines under the failure.
    expect(screen.getByText("Step thread failed · Out of memory")).toBeDefined();
    expect(screen.getByText("Exit code 1")).toBeDefined();
    expect(screen.getByLabelText("Last log lines").textContent).toBe("2 of 40 tests failed");

    fireEvent.click(screen.getByRole("button", { name: "JSON" }));
    expect(screen.getByLabelText("Error of summary").textContent).toBe(
      JSON.stringify(error, null, 2),
    );
    fireEvent.click(screen.getByRole("tab", { name: "Cost" }));
    expect(screen.getByLabelText("Cost of summary").textContent).toBe(
      JSON.stringify(cost, null, 2),
    );

    fireEvent.click(screen.getByRole("tab", { name: "Output" }));
    const advisories = screen.getByRole("list", { name: "Advisories" });
    expect(advisories.textContent).toBe(
      "The `skipped` branch is not wired, so 2 items were dropped.",
    );
  });

  it("pins output as stored, read from its artifact, and refuses a file or a second output", async () => {
    const succeeded = fixtureRun(WORKFLOW_RUN_IDS.failed);
    const withOutput = (outputRef: WorkflowStep["outputRef"]): WorkflowRunReadResponse => ({
      ...succeeded,
      steps: [summaryRecord(succeeded, { status: "succeeded", attempt: 1, outputRef })],
    });
    const items: WorkflowItem[] = [{ json: { summary: "Two cases skipped." } }];
    const artifactOutput = {
      kind: "artifact",
      artifactId: OUTPUT_ARTIFACT,
      sizeBytes: 90_000,
      itemCount: 1,
    } as const;

    const calls = renderPanel(withOutput(artifactOutput), { artifactText: JSON.stringify(items) });
    fireEvent.click(screen.getByRole("button", { name: "Pin this output as builder test data" }));
    await waitFor(() => {
      expect(calls.filter((call) => call.method === "workflow.pinDataSet")).toStrictEqual([
        {
          method: "workflow.pinDataSet",
          params: { definitionId: succeeded.definitionId, nodeId: "summary", items },
        },
      ]);
    });
    await waitFor(() => {
      expect(document.querySelector('[data-live-region="polite"]')?.textContent).toBe(
        "summary output pinned onto the builder",
      );
    });
    expect(
      screen.getByRole("button", { name: "Pin this output as builder test data" }),
    ).toBeDefined();
    cleanup();

    const fileItems: WorkflowItem[] = [
      { json: { log: "build-17.log" }, binary: { data: FILE_REF } },
    ];
    const fileCalls = renderPanel(withOutput(artifactOutput), {
      artifactText: JSON.stringify(fileItems),
    });
    fireEvent.click(screen.getByRole("button", { name: "Pin this output as builder test data" }));
    expect(
      await screen.findByText("Output that carries a file cannot be pinned as test data."),
    ).toBeDefined();
    expect(fileCalls.some((call) => call.method === "workflow.pinDataSet")).toBe(false);
    cleanup();

    renderPanel(withOutput({ kind: "inline", items: fileItems }));
    expect(
      screen.getByRole("button", { name: "Pin this output as builder test data" }),
    ).toHaveProperty("disabled", true);
    cleanup();

    const version = WORKFLOW_DEFINITION_RECORDS.flatMap((record) => record.versions)[0];
    if (version === undefined) {
      throw new Error("the fixture daemon holds no saved version");
    }
    const twoOutputs: WorkflowDocument = {
      ...version.document,
      edges: ["0", "1"].map((port) => ({
        id: `summary-${port}`,
        source: "summary" as WorkflowStep["nodeId"],
        sourceHandle: `outputs/main/${port}`,
        target: "next" as WorkflowStep["nodeId"],
        targetHandle: "inputs/main/0",
      })),
    };
    renderPanel(withOutput({ kind: "inline", items }), { document: twoOutputs });
    expect(screen.getByText("Only a step with one main output can be pinned.")).toBeDefined();
  });

  it("reads Not reached on a node the run never reached, keeping its acts refused in words", () => {
    const failed = fixtureRun(WORKFLOW_RUN_IDS.failed);
    renderPanel({ ...failed, steps: failed.steps.filter((step) => step.nodeId !== "summary") });

    expect(screen.getByRole("button", { name: "Retry from this step" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(
      screen.getByRole("button", { name: "Pin this output as builder test data" }),
    ).toHaveProperty("disabled", true);
    expect(screen.getByRole("checkbox", { name: "Keep" })).toBeDefined();
    expect(screen.getByText("Not reached")).toBeDefined();
    expect(screen.getByText("Retry · this step was not reached")).toBeDefined();
    expect(screen.getByText("Pin · this step was not reached")).toBeDefined();
  });

  it("says in the daemon's words when it refuses the Keep mark", async () => {
    const refusal = Object.assign(new Error("That run is not on this machine."), {
      code: -32603,
      data: { type: "workflow.not_found" },
    });
    renderPanel(fixtureRun(WORKFLOW_RUN_IDS.failed), { keepRefusal: refusal });

    fireEvent.click(screen.getByRole("checkbox", { name: "Keep" }));
    expect(await screen.findByText("That run is not on this machine.")).toBeDefined();
  });

  it("opens the run's fix session again rather than making a second one", () => {
    const failed = fixtureRun(WORKFLOW_RUN_IDS.failed);
    const fixSessionId = "019b7a00-0280-75e5-8510-ada11a5a3009" as SessionId;
    const opened: string[] = [];
    const calls = renderPanel(
      { ...failed, fixSessionId },
      {
        onOpenSession: (sessionId) => {
          opened.push(sessionId);
        },
      },
    );

    fireEvent.click(screen.getByRole("button", { name: "Fix in a fresh session" }));
    expect(opened).toStrictEqual([fixSessionId]);
    expect(calls.some((call) => call.method === "workflow.fixSessionCreate")).toBe(false);
  });
});
