// What the phase graph makes of a park, as distinct from the fact that one exists.
//
// The arms suite next door counts cards and nodes; this one is about the reading each
// node is drawn with. They are separate claims because they can fail separately: a
// graph can draw every phase and still colour them all alike, which is exactly the
// defect these two cases were written for.

import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { WORKFLOWS_PARKED_RUN } from "../../bridge/scenarios/workflow-fixture-runs.js";
import {
  parkAwaitsPerson,
  parkSchedule,
  phasePark,
} from "../../workflows/runs/run-list-projection.js";
import {
  GRAPH_CHUNK_WAIT,
  PARKED,
  answeringBridge,
  paneContext,
  renderPane,
} from "./WorkflowRunPane.test-support.js";

describe("workflow run pane — what the graph says a park is waiting for", () => {
  /**
   * What the fixture's phases read as, through the projection's own two readings.
   *
   * Derived rather than written out, because the claim is that the graph agrees with
   * the classifier the park badge takes its tone from — and an expectation written by
   * hand would agree with whichever surface was consulted while writing it. `null`
   * is the not-parked case, which is the attribute being absent rather than present
   * and empty.
   */
  function expectedParkAttentionByPhase(): Map<string, string | null> {
    return new Map(
      WORKFLOWS_PARKED_RUN.phaseStates.map((phase) => {
        const park = phasePark(phase);
        if (park === undefined) {
          return [phase.phaseId, null];
        }
        return [
          phase.phaseId,
          parkAwaitsPerson(parkSchedule(park)) ? "awaiting-person" : "scheduled",
        ];
      }),
    );
  }

  function drawnParkAttentionByPhase(section: HTMLElement): Map<string | null, string | null> {
    return new Map(
      [...section.querySelectorAll(".react-flow__node")].map((node) => [
        node.getAttribute("data-id"),
        node.querySelector(".meridian-phase-node")?.getAttribute("data-park") ?? null,
      ]),
    );
  }

  it("draws each park as what it is waiting for, not merely as parked", async () => {
    // The defect: the graph set a parked flag from `parkReason`'s presence and the
    // sheet gave every parked node the amber border rule 3 reserves for a person
    // being needed — so the fixture's provider-limited phase, which the engine armed
    // a readable resume for, was drawn as demanding somebody while the badge beside
    // it correctly said nobody was being asked for anything.
    const section = renderPane(paneContext(PARKED, answeringBridge()));
    await waitFor(() => {
      expect(section.querySelectorAll(".meridian-phase-node")).toHaveLength(
        WORKFLOWS_PARKED_RUN.phaseStates.length,
      );
    }, GRAPH_CHUNK_WAIT);

    expect(drawnParkAttentionByPhase(section)).toStrictEqual(expectedParkAttentionByPhase());
    // The fixture carries both kinds at once, so the map above is a claim about two
    // readings rather than one repeated: without this it would pass over a graph that
    // gave every park the same treatment, which is the defect.
    const attentions = [...expectedParkAttentionByPhase().values()].filter(
      (attention) => attention !== null,
    );
    expect(new Set(attentions).size).toBe(2);
  });

  it("spends the amber exactly where the park cards spend it", async () => {
    // One phase, two surfaces, one reading. The card and the node are read together —
    // an operator scanning the graph for what needs them looks to the cards for why —
    // so a node in amber beside a neutral card is one of the two telling them to look
    // at something the other says needs nobody.
    const section = renderPane(paneContext(PARKED, answeringBridge()));
    await waitFor(() => {
      expect(section.querySelectorAll(".meridian-park").length).toBeGreaterThan(1);
    });
    // The park cards render with the served snapshot; the nodes exist only once the
    // graph module's dynamic import has resolved, so the node count is awaited too —
    // asserting on nodes straight after the cards raced that import under load.
    await waitFor(() => {
      expect(section.querySelectorAll(".meridian-phase-node")).toHaveLength(
        WORKFLOWS_PARKED_RUN.phaseStates.length,
      );
    }, GRAPH_CHUNK_WAIT);

    const amberNodes = section.querySelectorAll(
      '.meridian-phase-node[data-park="awaiting-person"]',
    );
    const amberCards = section.querySelectorAll(".meridian-park .meridian-chip--attention");
    expect(amberNodes).toHaveLength(amberCards.length);
    // Named counts rather than an equality that two zeroes would also satisfy: the
    // fixture parks two phases and exactly one of them is waiting on a person.
    expect(amberNodes).toHaveLength(1);
    expect(section.querySelectorAll(".meridian-phase-node[data-park]")).toHaveLength(2);
  });
});
