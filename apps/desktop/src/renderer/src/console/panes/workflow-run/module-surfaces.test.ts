// What the run pane's three data modules PUBLISH, asserted as exact sets.
//
// Each of them declared a closed set — the park attentions, the locally-raised refusal
// codes, the rank spacing — and exported it while nothing outside the file read it.
// The `export` publishes a set as part of the module's contract, and a published set
// with no consumer is how the next surface comes to restate the literals rather than
// import them, which is a second vocabulary that agrees until one of them moves.
//
// WHY THE EXACT SET AND NOT THREE ABSENCES. An absence check passes on a module that
// has stopped exporting anything, and it says nothing about the export added next
// week. The exact set fails on a re-published private set AND on a symbol published
// without a decision, which is the class the dead-code gate cannot report here:
// `knip.json` sets `ignoreExportsUsedInFile`, so an export a module reads itself is
// invisible to it by configuration.
//
// TYPES ARE NOT IN THESE SETS and cannot be — a module namespace is a runtime value,
// so `export type` is erased before this file sees it. The claim is about value
// exports, which is exactly where the defect was.

import { describe, expect, it } from "vitest";

import * as phaseSequenceLayout from "./phase-graph/phase-sequence-layout.js";
import * as phaseTopology from "./phase-graph/phase-topology.js";
import * as runControls from "./run-controls.js";

describe("the run pane's published module surfaces", () => {
  it("publishes the phase topology's readings and marks, and not its own closed set", () => {
    expect(Object.keys(phaseTopology).toSorted()).toStrictEqual(
      [
        "PHASE_PARK_ATTENTION_MARKS",
        "declaredEdges",
        "phaseDisplayText",
        "phasesNeverEligible",
      ].toSorted(),
    );
  });

  it("publishes the layout's pitch and its callers, and not the spacing under it", () => {
    expect(Object.keys(phaseSequenceLayout).toSorted()).toStrictEqual(
      [
        "PHASE_NODE_HEIGHT_PX",
        "PHASE_NODE_WIDTH_PX",
        "PHASE_RANK_PITCH_PX",
        "PhaseSequenceLayoutCache",
        "layoutPhaseSequence",
        "phaseSequenceSignature",
      ].toSorted(),
    );
  });

  it("publishes the run controls' actions and refusals, and not the code tuple", () => {
    expect(Object.keys(runControls).toSorted()).toStrictEqual(
      [
        "WORKFLOW_CANCEL_REASON_BYTE_CAP",
        "WORKFLOW_RUN_CONTROL_ACTIONS",
        "WORKFLOW_RUN_CONTROL_ORIGIN",
        "cancelReasonBudget",
        "reasonPastBoundRefusal",
        "unregisteredRunControl",
      ].toSorted(),
    );
  });

  it("negative control: the three sets are non-empty and the private names are gone", () => {
    // Without this the three cases above would each be satisfied by a module that had
    // stopped exporting anything at all — a green run over an unreachable pane.
    const published = [
      Object.keys(phaseTopology),
      Object.keys(phaseSequenceLayout),
      Object.keys(runControls),
    ];
    for (const names of published) {
      expect(names.length).toBeGreaterThan(0);
    }
    expect(published.flat()).not.toContain("PHASE_PARK_ATTENTIONS");
    expect(published.flat()).not.toContain("PHASE_RANK_SPACING_PX");
    expect(published.flat()).not.toContain("WORKFLOW_RUN_CONTROL_REFUSAL_CODES");
  });
});
