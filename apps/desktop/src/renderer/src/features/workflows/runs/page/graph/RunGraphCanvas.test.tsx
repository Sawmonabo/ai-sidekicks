// The run's canvas keeps the graph library's attribution mark at its corner, a link to the
// library's site, never hidden.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  WORKFLOW_DEFINITION_RECORDS,
  WORKFLOW_FIXTURE_NOW_MS,
  WORKFLOW_RUN_IDS,
  WORKFLOW_RUN_RECORDS,
} from "#fixtures/data/workflow/run/records.js";
import { RunGraphCanvas } from "./RunGraphCanvas.js";

describe("the run's canvas", () => {
  it("carries the graph library's attribution mark", () => {
    const run = WORKFLOW_RUN_RECORDS.find(
      (record) => record.read.workflowRunId === WORKFLOW_RUN_IDS.succeeded,
    )?.read;
    const document = WORKFLOW_DEFINITION_RECORDS.flatMap((record) => record.versions).find(
      (version) => version.versionId === run?.workflowVersionId,
    )?.document;
    if (run === undefined || document === undefined) {
      throw new Error("the fixture's finished run or its document is missing");
    }
    render(
      <div className="meridian-run-graph">
        <RunGraphCanvas
          document={document}
          steps={run.steps}
          edgeItemCounts={run.edgeItemCounts}
          selectedNodeId={undefined}
          nowMs={WORKFLOW_FIXTURE_NOW_MS}
          onSelectNode={() => undefined}
        />
      </div>,
    );

    const mark = screen.getByRole("link", { name: "React Flow attribution" });
    expect(mark.getAttribute("href")).toBe("https://reactflow.dev/attribution");
  });
});
