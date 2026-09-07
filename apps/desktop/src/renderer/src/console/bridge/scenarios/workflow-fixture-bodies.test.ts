// The body table, checked on the two claims that make it a derivation rather than a
// second copy.
//
//   1. Every identity a body publishes is the summary row's own. Eight facts with two
//      homes would be free to disagree the first time a version number moved, and the
//      whole point of composing the replies out of the summary table is that they
//      cannot.
//   2. The phases a body sequences are the phases its runs report. A body describing a
//      workflow the run table does not run would be a fixture whose two halves describe
//      two different sessions — and every screenshot taken of either would be a picture
//      of a state no daemon can produce.
//
// And one refusal: a version this fixture holds no body for is answered with nothing
// rather than with the latest body, because serving one would state that an older
// version's bytes are the current ones.

import { describe, expect, it } from "vitest";

import { WORKFLOWS_SCENARIO_DEFINITIONS } from "./workflow-fixture-definitions.js";
import {
  DEFINITION_RELEASE_CHECKS_SESSION,
  DEFINITION_SHIP_PIPELINE_PROJECT,
} from "./workflow-fixture-ids.js";
import { WORKFLOWS_SCENARIO_RUNS } from "./workflow-fixture-runs.js";
import { workflowDefinitionReadFor, workflowVersionBodyFor } from "./workflow-fixture-bodies.js";

describe("the workflow body table — every definition the browser lists can be opened", () => {
  it("answers the definition read for every summary row", () => {
    // The consequence of the reads becoming reachable: a row a person can press is a
    // row that has to lead somewhere. A table stating bodies for three of five would
    // refuse two definitions the browser had just listed.
    for (const summary of WORKFLOWS_SCENARIO_DEFINITIONS) {
      expect(workflowDefinitionReadFor(summary.id), summary.name).toBeDefined();
    }
  });

  it("publishes the summary row's own identity, never a second copy of it", () => {
    for (const summary of WORKFLOWS_SCENARIO_DEFINITIONS) {
      const definition = workflowDefinitionReadFor(summary.id);
      expect(definition?.name).toBe(summary.name);
      expect(definition?.scope).toBe(summary.scope);
      expect(definition?.scopeRef).toBe(summary.scopeRef);
      expect(definition?.versionNumber).toBe(summary.latestVersionNumber);
      expect(definition?.workflowVersionId).toBe(summary.latestWorkflowVersionId);
      expect(definition?.createdAt).toBe(summary.createdAt);
    }
  });

  it("answers the version read with the summary's own hash, and with a marker", () => {
    for (const summary of WORKFLOWS_SCENARIO_DEFINITIONS) {
      const body = workflowVersionBodyFor(summary.id, summary.latestVersionNumber);
      expect(body?.contentHash, summary.name).toBe(summary.contentHash);
      expect(body?.workflowVersionId).toBe(summary.latestWorkflowVersionId);
      // Present and non-empty, and deliberately not compared against a constant: no
      // corpus document registers a marker value, so what a fixture can state is that
      // a file form has one to carry.
      expect(body?.schemaVersion).toBeTruthy();
    }
  });

  it("holds no body for a version other than the latest", () => {
    const summary = WORKFLOWS_SCENARIO_DEFINITIONS[0];
    expect(summary).toBeDefined();
    if (summary === undefined) {
      return;
    }

    expect(workflowVersionBodyFor(summary.id, summary.latestVersionNumber - 1)).toBeUndefined();
  });

  it("holds nothing at all for a definition it does not carry", () => {
    expect(workflowDefinitionReadFor("019b7a10-0280-7c11-8100-def111159999")).toBeUndefined();
    expect(workflowVersionBodyFor("019b7a10-0280-7c11-8100-def111159999", 1)).toBeUndefined();
  });
});

describe("the workflow body table — the phases it states are the phases the runs report", () => {
  it("sequences every phase the run pinned to that definition reports", () => {
    // Read from the RUN side rather than from the body's own, which is what makes it a
    // check: a run's `phaseStates` name the phases the engine actually ran, so a body
    // missing one would be a definition that could not have produced that run.
    for (const [definitionId, latestVersionId] of [
      [DEFINITION_RELEASE_CHECKS_SESSION, releaseChecksLatestVersionId()],
      [DEFINITION_SHIP_PIPELINE_PROJECT, shipPipelineLatestVersionId()],
    ] as const) {
      const run = WORKFLOWS_SCENARIO_RUNS.find(
        (candidate) => candidate.workflowVersionId === latestVersionId,
      );
      expect(run, definitionId).toBeDefined();
      const definition = workflowDefinitionReadFor(definitionId);
      const sequenced = new Set(definition?.phaseDefinitions.map((phase) => phase.phaseId) ?? []);

      for (const phase of run?.phaseStates ?? []) {
        expect(sequenced.has(phase.phaseId), `${definitionId} / ${phase.phaseId}`).toBe(true);
      }
    }
  });

  it("names every phase, which is the fact no run read carries", () => {
    for (const summary of WORKFLOWS_SCENARIO_DEFINITIONS) {
      for (const phase of workflowDefinitionReadFor(summary.id)?.phaseDefinitions ?? []) {
        expect(phase.name, `${summary.name} / ${phase.phaseId}`).not.toBe("");
      }
    }
  });

  it("negative control: the phase sets are not all the same, so the table is consulted", () => {
    // Without this, both cases above would hold over a table that answered one
    // sequence for every definition — every run's phases would be contained in it and
    // every phase would have a name.
    const sequences = WORKFLOWS_SCENARIO_DEFINITIONS.map((summary) =>
      (workflowDefinitionReadFor(summary.id)?.phaseDefinitions ?? [])
        .map((phase) => phase.phaseId)
        .join(","),
    );

    expect(new Set(sequences).size).toBeGreaterThan(1);
  });
});

/** The version the working run is pinned to, read out of the summary table. */
function releaseChecksLatestVersionId(): string {
  return latestVersionIdOf(DEFINITION_RELEASE_CHECKS_SESSION);
}

/** The version the parked run is pinned to, read out of the summary table. */
function shipPipelineLatestVersionId(): string {
  return latestVersionIdOf(DEFINITION_SHIP_PIPELINE_PROJECT);
}

function latestVersionIdOf(definitionId: string): string {
  const summary = WORKFLOWS_SCENARIO_DEFINITIONS.find((candidate) => candidate.id === definitionId);
  if (summary === undefined) {
    throw new Error(`the workflows fixture no longer states ${definitionId}`);
  }
  return summary.latestWorkflowVersionId;
}
