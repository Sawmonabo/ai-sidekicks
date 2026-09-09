// The definition BODIES a detail pane reads: the phases each definition sequences,
// the entry record, and the schema version the stored body carries.
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
// what no enumeration carries: the PHASES, the entry record, and the schema version.
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
// THE SCHEMA VERSION IS THE STORED COLUMN AND NOT THE FILE'S MARKER. `schemaVersion`
// on the version read is served verbatim out of the definition's stored column, which
// the store holds as TEXT under an `N.N` constraint — so `1.0` is the shape a daemon
// can answer with, and a publisher-qualified identifier is a value no daemon could
// have stored to serve. The file form's own top-level marker is a different string in
// a different place, owned by the serializer next door; conflating the two put a
// response on every detail pane and export test that no conforming daemon produces.
// The console still compares neither against a constant: it renders this one and
// carries it into an exported file.

import type {
  McpServerBindingRef,
  WorkflowDefinitionReadResult,
  WorkflowDefinitionSummary,
  WorkflowEntry,
  WorkflowPhaseDefinition,
  WorkflowVersionBody,
} from "../../wire-shapes/index.js";
import { WORKFLOWS_SCENARIO_DEFINITIONS } from "./definitions.js";
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
} from "./ids.js";

/**
 * The schema version every body in this fixture carries.
 *
 * One binding rather than five literals, and `N.N` because that is the only shape the
 * stored column admits — see the header for why this is not the file form's marker.
 * What a surface does with it is render it and carry it into an exported file.
 */
const FIXTURE_SCHEMA_VERSION = "1.0";

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
 *
 * `dependsOn` IS ALL-OR-NONE, AND EACH BODY BELOW PICKS ONE ARM WHOLE. The field is
 * the persisted spelling of the sequence edges, and supplying it on some phases of a
 * definition and not others is a typed refusal server-side — so a body spelling half a
 * topology is one the daemon rejects, which is the opposite of what a fixture
 * demonstrating a round trip is for. Four of the five omit it on every phase, where
 * the phase array's own order IS the chain and the stored bytes stay exactly what was
 * submitted. `Ship pipeline` at `project` scope declares it on every phase, because it
 * is the one definition here whose RUN could not have come from a chain: the parked run
 * has `Build and test` and `Release sign-off` running at the same instant, which only a
 * fan-out produces. It is therefore also the fixture's one join, and the one body that
 * exercises a join policy at all.
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
    },
    {
      phaseId: PHASE_REVIEW,
      name: "Review the results",
      type: "human",
      gateType: "human-approval",
      // The one phase whose failure sends the run backwards, so a detail pane has a
      // `goBackTo` target to render and not only three phases that stop. A reset
      // target and not an edge, which is why it stands on a body that declares no
      // edges at all: the cycle check would reject the edge spelling of it.
      failureBehavior: "go-back-to",
      goBackTo: PHASE_BUILD,
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
    },
  ],
  // The fixture's one declared topology, and the only shape that explains its own run:
  // `Draft the change` fans out to a build and a human sign-off that proceed together,
  // and `Publish` is the join they converge on. Read the parked run beside it — two
  // phases `running` at one instant — and a serial chain is not a definition that run
  // could have come from.
  [DEFINITION_SHIP_PIPELINE_PROJECT]: [
    {
      phaseId: PHASE_DRAFT,
      name: "Draft the change",
      type: "single-agent",
      gateType: "auto-continue",
      failureBehavior: "retry",
      // The entry node's successor, which is what an empty list means. Every phase
      // here states the member because the field is all-or-none across a definition.
      dependsOn: [],
    },
    {
      phaseId: PHASE_BUILD,
      name: "Build and test",
      // The one multi-agent phase, and it carries NO join policy: within-phase agent
      // multiplicity and graph fan-in are two different things, and the policy governs
      // the second. It belongs on the phase the branches converge on, which is
      // `Publish` below, and on no phase that merely lists one predecessor.
      type: "multi-agent",
      gateType: "quality-checks",
      failureBehavior: "retry",
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
      // The fan-out's second branch: `Draft the change` appears in two lists, which is
      // what makes it one, and a person signs off while the build runs.
      dependsOn: [PHASE_DRAFT],
    },
    {
      phaseId: PHASE_PUBLISH,
      name: "Publish",
      type: "automated",
      gateType: "done",
      failureBehavior: "stop",
      // The join: two predecessors, so the policy is required exactly here. Both
      // branches have to settle before a publish goes out, which is what `all-settled`
      // says and what neither of the other two policies would.
      dependsOn: [PHASE_BUILD, PHASE_SIGN_OFF],
      parallelJoinPolicy: "all-settled",
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
    },
    {
      phaseId: PHASE_PUBLISH,
      name: "Publish",
      type: "automated",
      gateType: "done",
      failureBehavior: "stop",
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
