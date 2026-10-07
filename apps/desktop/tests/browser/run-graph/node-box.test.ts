// A run graph node's box is derived from its kind's row in canvas units, so at the largest text
// size every line still fits inside it, its kind's label whole, and every node of a kind is one
// width, wider where its kind's label is longer. The gap between columns is derived from the
// widest edge count, so a label never stands on a node. This needs real layout: a DOM shim
// measures every box as zero.

import { waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { WorkflowEdgeItemCount } from "@ai-sidekicks/contracts/workflow/run/records";

import { TEXT_SIZES } from "#shared/appearance.js";
import { WORKFLOW_RUN_IDS } from "#fixtures/data/workflow/run/records.js";
import { fixtureRun, mountRunGraph, type FixtureRun } from "./mount.js";

afterEach(() => {
  document.documentElement.style.fontSize = "";
});

/** `fixture`'s graph at the largest text size, once it is fitted, painted and placed. */
async function mountAtLargestTextSize(
  fixture: FixtureRun,
  edgeItemCounts?: readonly WorkflowEdgeItemCount[],
): Promise<HTMLElement> {
  document.documentElement.style.fontSize = `${String(Math.max(...TEXT_SIZES))}px`;
  return (await mountRunGraph(fixture, edgeItemCounts)).container;
}

describe("a run graph node at the largest text size", () => {
  // The failed run carries a node with its one extra line, the tallest box the graph draws; the
  // waiting-for-a-reply run carries the longest kind label, `human.wait-for-chat-reply`.
  it.each([WORKFLOW_RUN_IDS.failed, WORKFLOW_RUN_IDS.waitingReply])(
    "holds every line whole, one width per kind (%s)",
    async (runId) => {
      const container = await mountAtLargestTextSize(fixtureRun(runId));

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

      const widthsByKind = new Map<string, Set<number>>();
      for (const node of nodes) {
        const kind = kindRowOf(node).textContent;
        widthsByKind.set(kind, (widthsByKind.get(kind) ?? new Set()).add(node.offsetWidth));
      }
      const kinds = [...widthsByKind.keys()];
      expect(new Set(kinds.map((kind) => kind.length)).size).toBeGreaterThan(1);
      for (const [kind, widths] of widthsByKind) {
        expect(widths.size, `every ${kind} node is one width`).toBe(1);
      }
      // The kind words are measured per character, so words with more characters take more room.
      const widthOf = (kind: string): number => Math.max(...(widthsByKind.get(kind) ?? []));
      for (const kind of kinds) {
        for (const shorter of kinds.filter((candidate) => candidate.length < kind.length)) {
          expect(widthOf(kind), `${kind} beside ${shorter}`).toBeGreaterThan(widthOf(shorter));
        }
      }
    },
  );
});

describe("an edge's item count at the largest text size", () => {
  // Every edge carries a count fifteen characters wide in full, drawn short. The release
  // review's document carries no places of its own, so the page lays it out itself; a document
  // the builder placed keeps the places its author gave.
  it("stands clear of both nodes, however long", async () => {
    const fixture = fixtureRun(WORKFLOW_RUN_IDS.waitingApproval);
    const { workflowDocument } = fixture;
    const longCounts = workflowDocument.edges.map((edge) => ({
      edgeId: edge.id,
      itemCount: 123_456_789_012,
    }));
    const shortCounts = longCounts.map((count) => ({ ...count, itemCount: 9 }));
    const shortGraph = await mountAtLargestTextSize(fixture, shortCounts);
    const shortWidths = nodeWidths(shortGraph);
    const container = await mountAtLargestTextSize(fixture, longCounts);
    // A count's length never moves a node: every box is sized for the widest short form.
    expect(nodeWidths(container)).toEqual(shortWidths);

    // The library draws a label once it has measured its text, so the wait is on that state.
    const labels = await waitFor(() => {
      const drawn = [
        ...container.querySelectorAll<SVGGElement>(".react-flow__edge-textwrapper"),
      ].filter((label) => label.getAttribute("visibility") === "visible");
      expect(drawn).toHaveLength(workflowDocument.edges.length);
      return drawn;
    });
    // The count is drawn short, the whole count is its title.
    for (const label of labels) {
      const text = label.querySelector(".react-flow__edge-text");
      expect(text?.querySelector("title")?.textContent).toBe("123,456,789,012 items");
      expect(text?.querySelector("tspan")?.lastChild?.textContent).toBe("123B");
    }
    const nodeBoxes = [...container.querySelectorAll<HTMLElement>(".react-flow__node")].map(
      (node) => ({ id: node.dataset["id"], box: node.getBoundingClientRect() }),
    );
    const overlaps = labels.flatMap((label) => {
      const labelBox = label.getBoundingClientRect();
      return nodeBoxes
        .filter(({ box }) => isOverlapping(labelBox, box))
        .map(({ id }) => `${label.textContent} on ${String(id)}`);
    });
    expect(overlaps).toEqual([]);
  });
});

function nodeWidths(container: HTMLElement): Record<string, number> {
  return Object.fromEntries(
    [...container.querySelectorAll<HTMLElement>(".react-flow__node")].map((node) => [
      node.dataset["id"] ?? "",
      node.offsetWidth,
    ]),
  );
}

function isOverlapping(first: DOMRect, second: DOMRect): boolean {
  return (
    first.left < second.right &&
    second.left < first.right &&
    first.top < second.bottom &&
    second.top < first.bottom
  );
}

function kindRowOf(node: HTMLElement): HTMLElement {
  const kindRow = node.querySelector<HTMLElement>(".meridian-run-graph-node__kind");
  if (kindRow === null) {
    throw new Error("a node drew no kind row");
  }
  return kindRow;
}
