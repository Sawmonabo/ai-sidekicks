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

import type { WorkflowVersionBody } from "../wire-shapes/workflow-definition-body.js";
import {
  WORKFLOW_FAILURE_BEHAVIORS,
  WORKFLOW_GATE_TYPES,
  WORKFLOW_PARALLEL_JOIN_POLICIES,
  WORKFLOW_PHASE_TYPES,
} from "../wire-shapes/workflow-definition-body.js";
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

  it("answers the version read with the summary's own hash", () => {
    for (const summary of WORKFLOWS_SCENARIO_DEFINITIONS) {
      const body = workflowVersionBodyFor(summary.id, summary.latestVersionNumber);
      expect(body?.contentHash, summary.name).toBe(summary.contentHash);
      expect(body?.workflowVersionId).toBe(summary.latestWorkflowVersionId);
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

describe("the workflow body table — every body is one a daemon could have stored", () => {
  // The claim this suite makes is not that a body renders: it is that the bytes a
  // surface renders are bytes `workflow.definitionCreate` would have accepted and
  // `workflow.versionRead` could answer with. A fixture that fails these is a console
  // demonstrating a round trip against a definition the daemon refuses, and every
  // screenshot taken of one is a picture of a state no daemon can produce.

  it("declares `dependsOn` on every phase of a body or on none of them", () => {
    // All-or-none, which the owning contract makes a typed refusal server-side: when
    // every phase omits it, the phase array's own order declares the chain; when one
    // phase carries it, all of them must. A body spelling half a topology reaches the
    // daemon as an inconsistent one and is refused.
    for (const { label, body } of everyVersionBody()) {
      const declaring = body.phaseDefinitions.filter((phase) => phase.dependsOn !== undefined);
      const allOrNone = declaring.length === 0 || declaring.length === body.phaseDefinitions.length;

      expect(
        allOrNone,
        `${label} declares dependsOn on ${declaring.length} of ${body.phaseDefinitions.length} phases`,
      ).toBe(true);
    }
  });

  it("carries a join policy exactly on a join, and on no other phase", () => {
    // The policy governs GRAPH FAN-IN and has nothing to do with a phase's own agent
    // multiplicity: it is required where a phase lists more than one predecessor and
    // refused everywhere else, whatever the phase's declared type is.
    for (const { label, body } of everyVersionBody()) {
      for (const phase of body.phaseDefinitions) {
        const isJoin = (phase.dependsOn ?? []).length > 1;

        expect(
          phase.parallelJoinPolicy !== undefined,
          `${label} / ${phase.name} (${(phase.dependsOn ?? []).length} predecessors)`,
        ).toBe(isJoin);
      }
    }
  });

  it("carries a schema version the store's own column constraint admits", () => {
    // The served field is the stored one, and the store holds it as TEXT under an
    // `N.N` constraint. It is NOT the file form's top-level marker, which is a
    // different string in a different place; a fixture conflating the two teaches a
    // surface that a daemon can answer with a value no daemon can store.
    for (const { label, body } of everyVersionBody()) {
      expect(body.schemaVersion, label).toMatch(/^[0-9]+\.[0-9]+$/);
    }
  });

  it("carries exactly one entry record, holding the one V1 start mode", () => {
    for (const { label, body } of everyVersionBody()) {
      // The keys rather than the value alone: the record is a single-value structure
      // and a second member would be the fixture declaring an arm no engine honours.
      expect(Object.keys(body.entry), label).toStrictEqual(["startMode"]);
      expect(body.entry.startMode, label).toBe("manual");
    }
  });

  it("spells every closed member as a member of its declaring tuple", () => {
    // Read off the tuples the wire shapes declare rather than off a list written here:
    // a widened vocabulary is then an amendment those tuples carry, and this check
    // moves with it instead of pinning a fifth value nobody registered.
    for (const { label, body } of everyVersionBody()) {
      for (const phase of body.phaseDefinitions) {
        const where = `${label} / ${phase.name}`;

        expect(WORKFLOW_PHASE_TYPES, where).toContain(phase.type);
        expect(WORKFLOW_GATE_TYPES, where).toContain(phase.gateType);
        expect(WORKFLOW_FAILURE_BEHAVIORS, where).toContain(phase.failureBehavior);
        if (phase.parallelJoinPolicy !== undefined) {
          expect(WORKFLOW_PARALLEL_JOIN_POLICIES, where).toContain(phase.parallelJoinPolicy);
        }
      }
    }
  });

  it("declares every dependency over its own phases, from exactly one entry successor", () => {
    // What the all-or-none check above cannot see: a body that carries the field
    // everywhere and still names a phase it does not sequence, depends on itself, or
    // declares two starting points. An empty list marks the entry node's successor,
    // and a definition has exactly one entry node.
    for (const { label, body } of everyVersionBody()) {
      const declaring = body.phaseDefinitions.filter((phase) => phase.dependsOn !== undefined);
      if (declaring.length === 0) {
        continue;
      }
      const phaseIds = new Set(body.phaseDefinitions.map((phase) => phase.phaseId));

      for (const phase of declaring) {
        for (const predecessorPhaseId of phase.dependsOn ?? []) {
          expect(phaseIds.has(predecessorPhaseId), `${label} / ${phase.name}`).toBe(true);
          expect(predecessorPhaseId, `${label} / ${phase.name}`).not.toBe(phase.phaseId);
        }
      }

      const entrySuccessors = declaring
        .filter((phase) => (phase.dependsOn ?? []).length === 0)
        .map((phase) => phase.name);

      expect(entrySuccessors, label).toHaveLength(1);
    }
  });
});

/**
 * Every body this fixture states, each labelled by the definition it belongs to.
 *
 * LABELLED BY NAME AND SCOPE, because two names appear at two scopes each: a failure
 * reading `Ship pipeline` would leave a reader to work out which of the two bodies
 * broke. Resolved through the version read rather than the phase table directly, so
 * what these checks walk is the reply a surface actually receives.
 */
function everyVersionBody(): readonly {
  readonly label: string;
  readonly body: WorkflowVersionBody;
}[] {
  return WORKFLOWS_SCENARIO_DEFINITIONS.map((summary) => {
    const body = workflowVersionBodyFor(summary.id, summary.latestVersionNumber);
    if (body === undefined) {
      throw new Error(
        `the workflows fixture states no body for ${summary.name} (${summary.scope})`,
      );
    }
    return { label: `${summary.name} (${summary.scope})`, body };
  });
}

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
