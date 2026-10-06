// A run graph node's box is derived from its kind's row in canvas units, so at the largest text
// size every line still fits inside it, its kind's label whole, and every node of a kind is one
// width, wider where its kind's label is longer. This needs real layout: a DOM shim measures
// every box as zero.

import { afterEach, describe, expect, it } from "vitest";

import type { WorkflowDocument } from "@ai-sidekicks/contracts/workflow/definition/definition";
import type { WorkflowRunReadResponse } from "@ai-sidekicks/contracts/workflow/run/records";

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

/** A fixture run and the document it ran, found by the run's id. */
function fixtureRun(runId: string): {
  readonly run: WorkflowRunReadResponse;
  readonly workflowDocument: WorkflowDocument;
} {
  const run = WORKFLOW_RUN_RECORDS.find((record) => record.read.workflowRunId === runId)?.read;
  const workflowDocument = WORKFLOW_DEFINITION_RECORDS.flatMap((record) => record.versions).find(
    (version) => version.versionId === run?.workflowVersionId,
  )?.document;
  if (run === undefined || workflowDocument === undefined) {
    throw new Error(`the fixture's run ${runId} or its document is missing`);
  }
  return { run, workflowDocument };
}

describe("a run graph node at the largest text size", () => {
  // The failed run carries a node with its one extra line, the tallest box the graph draws; the
  // waiting-for-a-reply run carries the longest kind label, `human.wait-for-chat-reply`.
  it.each([WORKFLOW_RUN_IDS.failed, WORKFLOW_RUN_IDS.waitingReply])(
    "holds every line whole, one width per kind (%s)",
    async (runId) => {
      const { run, workflowDocument } = fixtureRun(runId);
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
      // Scroll sizes are layout sizes, untouched by the zoom's transform. A line clips its own
      // text, so a box too short for its lines squeezes them: a line's text then stands taller
      // than the line, or the lines together taller than the room inside the ring. The kind row
      // never truncates, so a box too narrow for it shows as the kind or the box spilling across.
      const spills = nodes.flatMap((node) => {
        const kindRow = kindRowOf(node);
        return [
          ...[node, ...node.querySelectorAll<HTMLElement>("span")]
            .filter((box) => box.scrollHeight > box.clientHeight)
            .map((box) => `${box.className} down`),
          ...[node, kindRow]
            .filter((box) => box.scrollWidth > box.clientWidth)
            .map((box) => `${box.className} across`),
        ];
      });
      expect(spills).toEqual([]);

      const widthByKind = new Map<string, Set<number>>();
      for (const node of nodes) {
        const kind = kindRowOf(node).textContent;
        widthByKind.set(kind, (widthByKind.get(kind) ?? new Set()).add(node.offsetWidth));
      }
      const kinds = [...widthByKind.keys()];
      expect(new Set(kinds.map((kind) => kind.length)).size).toBeGreaterThan(1);
      for (const [kind, widths] of widthByKind) {
        expect(widths.size, `every ${kind} node is one width`).toBe(1);
      }
      for (const kind of kinds) {
        for (const other of kinds.filter((candidate) => candidate.length !== kind.length)) {
          expect(widthByKind.get(kind), `${kind} beside ${other}`).not.toEqual(
            widthByKind.get(other),
          );
        }
      }
    },
  );
});

function kindRowOf(node: HTMLElement): HTMLElement {
  const kindRow = node.querySelector<HTMLElement>(".meridian-run-graph-node__kind");
  if (kindRow === null) {
    throw new Error("a node drew no kind row");
  }
  return kindRow;
}
