// A run graph node is part of the drawing: its box is stated in canvas units, so its lines must
// be too. At the largest text size every node's lines still fit inside its box. This needs real
// layout: a DOM shim measures every box as zero.

import { afterEach, describe, expect, it } from "vitest";

import { TEXT_SIZES } from "#shared/appearance.js";
import { renderSettled } from "../helpers/app/harness.js";
import { awaitRunGraphSettled } from "../helpers/run-graph-settled.js";
import {
  WORKFLOW_DEFINITION_RECORDS,
  WORKFLOW_FIXTURE_NOW_MS,
  WORKFLOW_RUN_IDS,
  WORKFLOW_RUN_RECORDS,
} from "#fixtures/data/workflow/run/records.js";
import { installMeridianTokens } from "#renderer/app/token-installation.js";
import { RunGraphCanvas } from "#renderer/features/workflows/runs/page/graph/RunGraphCanvas.js";

afterEach(() => {
  document.documentElement.style.fontSize = "";
});

describe("a run graph node at the largest text size", () => {
  it("keeps every line inside its box", async () => {
    // The failed run carries a node with its one extra line, the tallest box the graph draws.
    const run = WORKFLOW_RUN_RECORDS.find(
      (record) => record.read.workflowRunId === WORKFLOW_RUN_IDS.failed,
    )?.read;
    const workflowDocument = WORKFLOW_DEFINITION_RECORDS.flatMap((record) => record.versions).find(
      (version) => version.versionId === run?.workflowVersionId,
    )?.document;
    if (run === undefined || workflowDocument === undefined) {
      throw new Error("the fixture's failed run or its document is missing");
    }
    installMeridianTokens(document);
    document.documentElement.style.fontSize = `${String(Math.max(...TEXT_SIZES))}px`;

    const { container } = await renderSettled(
      <div className="meridian-run-graph">
        <RunGraphCanvas
          document={workflowDocument}
          steps={run.steps}
          edgeItemCounts={run.edgeItemCounts}
          selectedNodeId={undefined}
          nowMs={WORKFLOW_FIXTURE_NOW_MS}
          onSelectNode={() => undefined}
        />
      </div>,
    );
    await awaitRunGraphSettled(container);

    const nodes = [...container.querySelectorAll<HTMLElement>(".meridian-run-graph-node")];
    expect(nodes.some((node) => node.querySelector(".meridian-run-graph-node__error"))).toBe(true);
    // Scroll sizes are layout sizes, untouched by the zoom's transform. A line clips its own
    // text, so a box too short for its lines squeezes them: a line's text then stands taller
    // than the line, or the lines together taller than the room inside the ring.
    const spills = nodes.flatMap((node) =>
      [node, ...node.querySelectorAll<HTMLElement>("span")]
        .filter((box) => box.scrollHeight > box.clientHeight)
        .map((box) => box.className),
    );
    expect(spills).toEqual([]);
  });
});
