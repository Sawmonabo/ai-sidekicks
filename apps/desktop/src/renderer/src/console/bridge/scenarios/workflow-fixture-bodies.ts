// The definition BODIES a detail pane reads: the phases each definition sequences,
// the entry record, and the schema marker a file form carries.
//
// One of the workflow fixture's five data modules; `workflow-fixture-ids.ts` carries
// the framing all five share and the definition ids this table and the summary table
// must agree on.
//
// THE BODY IS DERIVED FROM THE SUMMARY AND NOT WRITTEN BESIDE IT. A definition's id,
// name, scope, scope reference, latest version number, latest version id, content
// hash and creation instant are all published by the summary row the browser already
// lists, and a body table restating them would be eight facts with two homes — free
// to disagree the first time a version number moved. What is genuinely new here is
// what no enumeration carries: the PHASES, the entry record, and the schema marker.
// So this module holds exactly those, keyed by definition id, and composes the two
// read replies out of them and the summary row.
//
// WHY EVERY DEFINITION HAS A BODY AND ONLY THREE HAVE A CHAIN. Both reads are now
// reachable from a browser row, so a definition a person can open is a definition
// this fixture must be able to describe — five of five. The CHAIN is addressed by a
// version id and answers the re-pin picker, so it is stated for the three definitions
// this scenario's runs are pinned to and for no others, which is the disposition the
// chain table already had. The consequence is deliberate and is a state worth
// drawing: opening one of the other two serves the identity and the body and refuses
// the chain, which is exactly the partial reading rule 8 asks a surface to render
// rather than fold into one absence.
//
// THE PHASE NAMES ARE THE FIRST IN THIS FIXTURE. `WorkflowPhaseState` carries a
// `phaseId` and no name, so a run pane has an id and an honest absence; the readable
// name lives in the body, which is what this table is. A run surface reading one
// would be reading the definition as well as the run, and nothing here does that for
// it.
//
// THE SCHEMA MARKER'S VALUE IS FIXTURE DATA. No corpus document registers a marker
// string, so the console never compares one against a constant: a file form carries
// it through verbatim, and the parser next to the serializer requires it to be
// PRESENT rather than to equal anything. A fixture value that a console validated
// against would be this fixture teaching a surface a wire fact traceable to nothing.

import type {
  McpServerBindingRef,
  WorkflowDefinitionReadResult,
  WorkflowDefinitionSummary,
  WorkflowEntry,
  WorkflowPhaseDefinition,
  WorkflowVersionBody,
} from "../wire-shapes/index.js";
import { WORKFLOWS_SCENARIO_DEFINITIONS } from "./workflow-fixture-definitions.js";
import {
  DEFINITION_INCIDENT_TRIAGE_SHARED,
  DEFINITION_RELEASE_CHECKS_PROJECT,
  DEFINITION_RELEASE_CHECKS_SESSION,
  DEFINITION_SHIP_PIPELINE_PROJECT,
  DEFINITION_SHIP_PIPELINE_SHARED,
  PHASE_BUILD,
  PHASE_DRAFT,
  PHASE_PUBLISH,
  PHASE_REVIEW,
  PHASE_SIGN_OFF,
} from "./workflow-fixture-ids.js";

/**
 * The marker every body in this fixture carries.
 *
 * One binding rather than five literals, and deliberately not a constant the console
 * checks against: see the header. What a surface does with it is render it and carry
 * it into an exported file.
 */
const FIXTURE_SCHEMA_VERSION = "ai-sidekicks.workflow/v1";

/**
 * How every definition in this fixture starts.
 *
 * `manual` on all five because `startMode` has exactly that one member at this
 * contract revision — a second value would be the fixture widening a closed set the
 * wire shapes declare.
 */
const MANUAL_ENTRY: WorkflowEntry = { startMode: "manual" };

// The three server bindings this fixture's tool-bearing phases reference, one per
// scope arm, so a detail pane rendering a binding is rendering each shape the union
// admits rather than three copies of the easiest one. `local` is Claude-only and
// carries its scope reference exactly as `project` does; `user` carries none, which
// is the arm a renderer most easily gets wrong by printing an empty string. Both
// providers appear, because the binding's provider is part of its identity and a
// table naming one of them would let a renderer drop the member and still look right.
const PROJECT_BINDING: McpServerBindingRef = {
  provider: "codex",
  serverName: "atlas-release",
  scope: "project",
  scopeRef: "/Users/operator/work/atlas",
};
const USER_BINDING: McpServerBindingRef = {
  provider: "claude",
  serverName: "notes",
  scope: "user",
};
const LOCAL_BINDING: McpServerBindingRef = {
  provider: "claude",
  serverName: "incident-log",
  scope: "local",
  scopeRef: "/Users/operator/work/atlas",
};

/**
 * The phases each definition sequences, in the order it runs them.
 *
 * KEYED BY DEFINITION AND NOT BY VERSION, because this fixture states one body per
 * definition — its latest — and a read addressed at any other version number refuses.
 * A per-version table would be twenty-one bodies to answer a question no surface in
 * this build puts: the detail pane opens on the latest, and the chain read answers
 * which other versions exist without claiming to hold their bodies.
 *
 * The phase ids are the five `workflow-fixture-ids.ts` declares, which is what lets a
 * run's `phaseStates` and its definition's `phaseDefinitions` line up: the working
 * run's three phases are `Release checks`' three, and the parked run's four are `Ship
 * pipeline`'s four. A body with phases the run does not sequence would be a fixture
 * whose two halves describe two different workflows.
 */
const PHASE_SEQUENCES: Readonly<Record<string, readonly WorkflowPhaseDefinition[]>> = {
  [DEFINITION_RELEASE_CHECKS_SESSION]: [
    {
      phaseId: PHASE_DRAFT,
      name: "Draft the release note",
      type: "single-agent",
      gateType: "auto-continue",
      failureBehavior: "retry",
      toolBindings: [{ binding: USER_BINDING, toolName: "search_notes" }],
    },
    {
      phaseId: PHASE_BUILD,
      name: "Run the release checks",
      type: "automated",
      gateType: "quality-checks",
      failureBehavior: "retry",
      dependsOn: [PHASE_DRAFT],
    },
    {
      phaseId: PHASE_REVIEW,
      name: "Review the results",
      type: "human",
      gateType: "human-approval",
      // The one phase whose failure sends the run backwards, so a detail pane has a
      // `goBackTo` target to render and not only three phases that stop.
      failureBehavior: "go-back-to",
      goBackTo: PHASE_BUILD,
      dependsOn: [PHASE_BUILD],
    },
  ],
  [DEFINITION_RELEASE_CHECKS_PROJECT]: [
    {
      phaseId: PHASE_DRAFT,
      name: "Draft",
      type: "single-agent",
      gateType: "auto-continue",
      failureBehavior: "retry",
    },
    {
      phaseId: PHASE_REVIEW,
      name: "Review",
      type: "human",
      gateType: "done",
      failureBehavior: "stop",
      dependsOn: [PHASE_DRAFT],
    },
  ],
  [DEFINITION_SHIP_PIPELINE_PROJECT]: [
    {
      phaseId: PHASE_DRAFT,
      name: "Draft the change",
      type: "single-agent",
      gateType: "auto-continue",
      failureBehavior: "retry",
    },
    {
      phaseId: PHASE_BUILD,
      name: "Build and test",
      // The one multi-agent phase, and therefore the one carrying a join policy: the
      // member is meaningless on a phase that dispatches to a single agent, so a body
      // that set it everywhere would teach a renderer to draw it everywhere.
      type: "multi-agent",
      gateType: "quality-checks",
      failureBehavior: "retry",
      parallelJoinPolicy: "all-settled",
      dependsOn: [PHASE_DRAFT],
      toolBindings: [
        { binding: PROJECT_BINDING, toolName: "run_release_suite" },
        { binding: PROJECT_BINDING, toolName: "collect_artifacts" },
      ],
    },
    {
      phaseId: PHASE_SIGN_OFF,
      name: "Release sign-off",
      type: "human",
      gateType: "human-approval",
      failureBehavior: "stop",
      dependsOn: [PHASE_BUILD],
    },
    {
      phaseId: PHASE_PUBLISH,
      name: "Publish",
      type: "automated",
      gateType: "done",
      failureBehavior: "stop",
      dependsOn: [PHASE_SIGN_OFF],
      config: { channel: "stable" },
    },
  ],
  [DEFINITION_SHIP_PIPELINE_SHARED]: [
    {
      phaseId: PHASE_DRAFT,
      name: "Draft",
      type: "single-agent",
      gateType: "auto-continue",
      failureBehavior: "retry",
    },
    {
      phaseId: PHASE_BUILD,
      name: "Build",
      type: "automated",
      gateType: "quality-checks",
      failureBehavior: "retry",
      dependsOn: [PHASE_DRAFT],
    },
    {
      phaseId: PHASE_PUBLISH,
      name: "Publish",
      type: "automated",
      gateType: "done",
      failureBehavior: "stop",
      dependsOn: [PHASE_BUILD],
    },
  ],
  [DEFINITION_INCIDENT_TRIAGE_SHARED]: [
    {
      phaseId: PHASE_DRAFT,
      name: "Triage the incident",
      type: "single-agent",
      gateType: "auto-continue",
      failureBehavior: "stop",
      toolBindings: [{ binding: LOCAL_BINDING, toolName: "append_incident_note" }],
    },
    {
      phaseId: PHASE_REVIEW,
      name: "Post-incident review",
      type: "human",
      gateType: "done",
      failureBehavior: "stop",
      dependsOn: [PHASE_DRAFT],
    },
  ],
};

/**
 * The summary this fixture publishes for one definition, or `undefined` for an id it
 * does not carry.
 *
 * The summary table is the ONE place a definition's identity is stated, so both
 * replies below resolve through here rather than each holding a copy.
 */
function summaryFor(definitionId: string): WorkflowDefinitionSummary | undefined {
  return WORKFLOWS_SCENARIO_DEFINITIONS.find((definition) => definition.id === definitionId);
}

/**
 * What `workflow.definitionRead` answers for one definition, or `undefined` for an id
 * this fixture states nothing about.
 *
 * The reply carries the definition's identity and the phase sequence its latest
 * version holds — which is what makes a browser row lead somewhere — and the version
 * id the chain read is addressed by. Composed from the summary and the phase table so
 * a version number the summary moved moves here in the same edit.
 */
export function workflowDefinitionReadFor(
  definitionId: string,
): WorkflowDefinitionReadResult | undefined {
  const summary = summaryFor(definitionId);
  const phaseDefinitions = PHASE_SEQUENCES[definitionId];
  if (summary === undefined || phaseDefinitions === undefined) {
    return undefined;
  }
  return {
    id: summary.id,
    name: summary.name,
    scope: summary.scope,
    // Carried straight through, empty string included. `WorkflowDefinitionSummary`
    // types the member as required and the `shared` rows carry `""` to mean
    // daemon-wide, so a body that dropped the empty one would be answering a
    // different question than the summary beside it — "no scope reference" rather
    // than "a scope that refers to nothing narrower".
    scopeRef: summary.scopeRef,
    versionNumber: summary.latestVersionNumber,
    workflowVersionId: summary.latestWorkflowVersionId,
    phaseDefinitions,
    createdAt: summary.createdAt,
  };
}

/**
 * What `workflow.versionRead` answers for one definition's LATEST version, or
 * `undefined` for a definition or a version number this fixture holds no body for.
 *
 * The version number is checked rather than ignored: a read addressed at version 2 of
 * a definition whose latest is 4 is a question this fixture cannot answer, and
 * answering it with the latest body would be the fixture stating that an older
 * version's bytes are the current ones — the same invention the run read's scope
 * check exists to refuse.
 */
export function workflowVersionBodyFor(
  definitionId: string,
  versionNumber: number,
): WorkflowVersionBody | undefined {
  const summary = summaryFor(definitionId);
  const phaseDefinitions = PHASE_SEQUENCES[definitionId];
  if (summary === undefined || phaseDefinitions === undefined) {
    return undefined;
  }
  if (versionNumber !== summary.latestVersionNumber) {
    return undefined;
  }
  return {
    definitionId: summary.id,
    versionNumber: summary.latestVersionNumber,
    workflowVersionId: summary.latestWorkflowVersionId,
    contentHash: summary.contentHash,
    schemaVersion: FIXTURE_SCHEMA_VERSION,
    name: summary.name,
    entry: MANUAL_ENTRY,
    phaseDefinitions,
    createdAt: summary.createdAt,
  };
}
