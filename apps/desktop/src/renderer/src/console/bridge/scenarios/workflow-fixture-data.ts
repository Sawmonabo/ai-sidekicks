// The workflow plane's fixture data: the definitions a browser groups, the four runs
// a list ranks, and the outputs a finished phase left behind.
//
// SPLIT FROM THE SCENARIO ON PURPOSE. `workflows.ts` owns the SESSION — the beats a
// daemon could emit and the replies a call is answered with — and this module owns
// the workflow STATE those replies carry. The two are different kinds of thing: a
// beat is held to `packages/contracts`' strict layer by `scenarios/wire-truth.ts`,
// while these shapes are declared by `bridge/workflow-projection.ts` because the
// corpus registers no workflow types at all. Keeping them in one file put a wire the
// contract owns and a wire the growth slate owes side by side under one header, and
// pushed it past the size a reader can hold.
//
// EVERYTHING HERE IS BEHIND ONE SLATE ROW. `workflow-run-control` owes nine of the
// thirteen registered workflow method strings together with the run, phase,
// definition, and output shapes they carry. Until it lands these are the console's
// consumption shapes and nothing claims otherwise; when it lands they are replaced by
// the registered types and this data is re-typed against them.

import type {
  WorkflowDefinitionSummary,
  WorkflowPhaseOutput,
  WorkflowRunSnapshot,
} from "../workflow-projection.js";

/** The session every fact below belongs to. The scenario's own id, stated once. */
export const WORKFLOWS_SESSION_ID = "019b7a10-0280-75e5-8510-ada11a5a3333";

/** The person this window is, and the actor on every beat a person caused. */
export const WORKFLOWS_PARTICIPANT_YOU = "019b7a10-0280-79a4-8110-cca0117a0110";

const AGENT_PLANNER = "019b7a10-0280-7a6e-8100-d1a4c1150001";
const AGENT_BUILDER = "019b7a10-0280-7a6e-8100-d1a4c1150002";

// Definition and version ids, named rather than inlined because the frozen-pin state
// is an INEQUALITY between two of them: a run pinned to `Ship pipeline` version 1
// against a definition whose latest is version 3. Written as two hand-typed literals
// that comparison is one typo away from being a fixture that proves nothing.
const DEFINITION_RELEASE_CHECKS = "019b7a10-0280-7c11-8100-def111150001";
const DEFINITION_SHIP_PIPELINE = "019b7a10-0280-7c11-8100-def111150002";
const DEFINITION_INCIDENT_TRIAGE = "019b7a10-0280-7c11-8100-def111150003";
const VERSION_RELEASE_CHECKS_LATEST = "019b7a10-0280-7d22-8100-be5100150004";
const VERSION_SHIP_PIPELINE_LATEST = "019b7a10-0280-7d22-8100-be5100150003";
const VERSION_SHIP_PIPELINE_PINNED = "019b7a10-0280-7d22-8100-be5100150001";
const VERSION_INCIDENT_TRIAGE_LATEST = "019b7a10-0280-7d22-8100-be5100150002";

const RUN_WORKING = "019b7a10-0280-7b33-8100-4011115a0001";
const RUN_PARKED = "019b7a10-0280-7b33-8100-4011115a0002";
const RUN_CANCELLED = "019b7a10-0280-7b33-8100-4011115a0003";
const RUN_FROZEN_PIN = "019b7a10-0280-7b33-8100-4011115a0004";

// Phase ids are UUIDs like every other identifier on these shapes: `WorkflowPhaseId`
// is a branded id in `docs/architecture/contracts/api-payload-contracts.md` §Branded
// ID Types rather than an author-chosen label. The phase's readable NAME is on none
// of the reads this fixture can answer — see the note above the run table.
const PHASE_DRAFT = "019b7a10-0280-7e44-8100-9ba5e1150001";
const PHASE_BUILD = "019b7a10-0280-7e44-8100-9ba5e1150002";
const PHASE_REVIEW = "019b7a10-0280-7e44-8100-9ba5e1150003";
const PHASE_SIGN_OFF = "019b7a10-0280-7e44-8100-9ba5e1150004";
const PHASE_PUBLISH = "019b7a10-0280-7e44-8100-9ba5e1150005";

/**
 * The provider account two of the four runs are parked against.
 *
 * One key shared by two runs is what makes the attention fold reachable at all:
 * concurrently parked runs sharing a `parkAttentionKey` render as ONE entry carrying
 * its affected-run count, and a fixture whose parks all carried distinct keys could
 * only ever drive the unfolded arm.
 */
const PARK_ATTENTION_KEY = "019b7a10-0280-7f55-8100-acc0117a0001";

/**
 * One agent a workflow's phases dispatch to, as both the beat and the reply carry it.
 *
 * Named rather than inferred from an `as const` literal because the table is exported
 * and `isolatedDeclarations` is repo-wide: an exported value needs a type a reader and
 * a declaration emitter can both see without reading the initializer.
 */
interface WorkflowScenarioAgent {
  readonly agentId: string;
  readonly name: string;
  readonly driverName: string;
  readonly modelId: string;
  /** The tick the attach beat is due at, measured from scenario start. */
  readonly attachedAtMs: number;
  readonly attachedAtIso: string;
}

/**
 * The two agents a phase-per-agent workflow attaches, as the `agents` projection
 * carries them.
 *
 * One table rather than a literal per beat and a second per reply, on the flagship's
 * precedent: the `agent.attached` payload is the replay-complete record `Spec-006
 * §Channel and Agent Lifecycle (session_lifecycle)` makes it, so the projection
 * rebuilds from it alone, and two hand-written copies of one agent would drift in
 * exactly the direction nothing catches. The drivers are deliberately mixed so the
 * parked story can show one phase waiting on a spent account while the other runs.
 */
export const WORKFLOWS_SCENARIO_AGENTS: readonly WorkflowScenarioAgent[] = [
  {
    agentId: AGENT_PLANNER,
    name: "Planner",
    driverName: "claude",
    modelId: "claude-opus-5[1m]",
    attachedAtMs: 80,
    attachedAtIso: "2026-01-01T07:00:00.080Z",
  },
  {
    agentId: AGENT_BUILDER,
    name: "Builder",
    driverName: "codex",
    modelId: "gpt-5.6-sol",
    attachedAtMs: 160,
    attachedAtIso: "2026-01-01T07:00:00.160Z",
  },
];

/** The run one `single-agent` phase dispatched, and the only run on the event stream. */
export const WORKFLOWS_PHASE_AGENT_RUN_ID: string = "019b7a10-0280-740e-8100-d1a4c1150011";

/** The agent that phase dispatched to. Named so the beat and the table agree. */
export const WORKFLOWS_PHASE_AGENT_ID: string = AGENT_BUILDER;

/** The phase whose outputs the phase-output read answers for. */
export const WORKFLOWS_COMPLETED_PHASE_ID: string = PHASE_DRAFT;

/**
 * The definitions the browser groups, in the daemon's own resolution order.
 *
 * Two names appear at more than one scope on purpose, because that is the only shape
 * in which `resolvesAtThisContext` says anything: the flag marks the one row per NAME
 * that most-specific-first resolution would pick, so a table where every name appeared
 * once would set it true everywhere and teach a reader nothing. Here a session copy
 * wins over a project copy of the same name, and a project copy wins over the shared
 * original — the rule read off the data rather than asserted beside it.
 *
 * `scopeRef` is the scope's identity and is not decorative: the authoring session's id
 * at `session`, the resolved repository root at `project`, and the empty string at
 * `shared`, which is daemon-wide and refers to nothing narrower.
 *
 * `contentHash` is BLAKE3 over the RFC 8785 canonicalization, carried verbatim and
 * rendered in mono. The console never parses one; it is here so a detail pane has a
 * real string to show rather than a placeholder shaped like a hash.
 */
export const WORKFLOWS_SCENARIO_DEFINITIONS: readonly WorkflowDefinitionSummary[] = [
  {
    id: DEFINITION_RELEASE_CHECKS,
    name: "Release checks",
    scope: "session",
    scopeRef: WORKFLOWS_SESSION_ID,
    latestVersionNumber: 4,
    latestWorkflowVersionId: VERSION_RELEASE_CHECKS_LATEST,
    contentHash: "b3:0f3c9a1d7e5b42c8a06d1f93be27540ac1d8e6b3927fa04c5de81b6203794acd",
    resolvesAtThisContext: true,
    // Inside the session, and therefore after it. The `project` and `shared` rows
    // below keep their older instants because they belong to a repository root and
    // to the daemon, neither of which this session's creation bounds; only a
    // `session`-scoped definition is owned by the session and constrained by it.
    createdAt: "2026-01-01T07:04:00.000Z",
  },
  {
    id: "019b7a10-0280-7c11-8100-def111150004",
    name: "Release checks",
    scope: "project",
    scopeRef: "/Users/operator/work/atlas",
    latestVersionNumber: 2,
    latestWorkflowVersionId: "019b7a10-0280-7d22-8100-be5100150005",
    contentHash: "b3:5a7e2b04c1d93f68027ba4e1d5c3098fa62b7413ed05c9a8b1f42760de3915cb",
    // False, and this is the row that makes the group order legible: a session
    // definition of the same name is more specific, so a run started here picks that
    // one and never this.
    resolvesAtThisContext: false,
    createdAt: "2025-11-02T16:40:00.000Z",
  },
  {
    id: DEFINITION_SHIP_PIPELINE,
    name: "Ship pipeline",
    scope: "project",
    scopeRef: "/Users/operator/work/atlas",
    latestVersionNumber: 3,
    latestWorkflowVersionId: VERSION_SHIP_PIPELINE_LATEST,
    contentHash: "b3:c4109de7f3b28a56014c9e2b7d6a3f5081ba9c37e2d40615fa8b73c091d2e648",
    resolvesAtThisContext: true,
    createdAt: "2025-10-21T11:05:00.000Z",
  },
  {
    id: "019b7a10-0280-7c11-8100-def111150005",
    name: "Ship pipeline",
    scope: "shared",
    scopeRef: "",
    latestVersionNumber: 7,
    latestWorkflowVersionId: "019b7a10-0280-7d22-8100-be5100150006",
    contentHash: "b3:9e21b7c0d4a63f18052e7ba9c136d40f8b27ea51c9038d647fa2b105e37c96da",
    resolvesAtThisContext: false,
    createdAt: "2025-08-09T08:30:00.000Z",
  },
  {
    id: DEFINITION_INCIDENT_TRIAGE,
    name: "Incident triage",
    scope: "shared",
    scopeRef: "",
    latestVersionNumber: 5,
    latestWorkflowVersionId: VERSION_INCIDENT_TRIAGE_LATEST,
    contentHash: "b3:76d0e39b2c8a41f5093be7d2a6c14f08e5b3a2701cd946fb85e37201da6cb493",
    resolvesAtThisContext: true,
    createdAt: "2025-07-14T13:22:00.000Z",
  },
];

/**
 * The parked run, declared on its own because two readers need exactly it.
 *
 * `workflow.runRead` addresses one run and answers with this one, while the table
 * below carries it as its second member — so a positional index would be the one
 * place the pane's run and the list's run could come apart. Named once, spread in
 * once, and the two cannot disagree.
 */
export const WORKFLOWS_PARKED_RUN: WorkflowRunSnapshot = {
  workflowRunId: RUN_PARKED,
  sessionId: WORKFLOWS_SESSION_ID,
  workflowVersionId: VERSION_SHIP_PIPELINE_LATEST,
  state: "suspended",
  startedAt: "2026-01-01T09:31:00.000Z",
  phaseStates: [
    {
      phaseId: PHASE_DRAFT,
      phaseRunId: "019b7a10-0280-7aa1-8100-701a11150003",
      attemptNumber: 1,
      state: "completed",
      gateState: "open",
    },
    {
      phaseId: PHASE_BUILD,
      phaseRunId: "019b7a10-0280-7aa1-8100-701a11150004",
      attemptNumber: 1,
      // `running` and parked at once, which is what the five-value union is kept
      // coarse for: the phase-run status carries no suspended arm, and the park
      // rides the members below it.
      state: "running",
      gateState: "closed",
      parkReason: "provider-usage-limited",
      parkCause:
        "The provider account reached its five-hour usage window. The next window opens at 10:45 UTC.",
      autoResumeAt: "2026-01-01T10:45:00.000Z",
      parkAttentionKey: PARK_ATTENTION_KEY,
    },
    {
      phaseId: PHASE_SIGN_OFF,
      phaseRunId: "019b7a10-0280-7aa1-8100-701a11150005",
      attemptNumber: 1,
      state: "running",
      gateState: "closed",
      // Zero rather than absent: this is a human phase whose attempt has no
      // accepted submission yet, which is what the optimistic-concurrency token
      // counts. Absent would mean an older daemon, not an unanswered form.
      formRevision: 0,
      parkReason: "waiting-human",
      parkCause: "Waiting on a release sign-off from a person before the publish phase runs.",
      // No `autoResumeAt` and no attention key. Nothing armed a resume, so nothing
      // shows a countdown, and a park with no provider account has nothing for the
      // provider-account fold to fold it with.
    },
    { phaseId: PHASE_PUBLISH, state: "pending", gateState: "closed" },
  ],
};

/**
 * The four runs, as `workflow.runRead` projects one of them and the scenario's
 * scripted enumeration holds all four.
 *
 * THE PARK MEMBERS ARE LIVE-SCOPED, and this table is written to that rule rather than
 * around it. A daemon emits `parkReason`, `parkCause`, `autoResumeAt`, and
 * `parkAttentionKey` for exactly the phases parked at the moment the response was
 * built and emits none of them for a phase that is not — so the cancelled run carries
 * no park member anywhere, even though a phase in it was parked once. "Why was this
 * parked" is a timeline question, answered from the suspension event rather than from
 * a stale member on a settled run.
 *
 * WHAT THE FOUR ARE FOR. Each is the only source of a fact the surfaces read:
 *
 *   1. Working — running, nothing parked. The band the list has to keep BELOW the
 *      parked band, so the ordering rule is observable rather than asserted.
 *   2. Parked — suspended, with two park kinds at once: a `provider-usage-limited`
 *      park the engine armed a resume for, and a `waiting-human` park it did not. One
 *      run therefore drives the countdown arm and the awaiting-resume arm together,
 *      which is the pair a banner most easily conflates.
 *   3. Cancelled — the cancellation reason on `failureReason` where the contract puts
 *      it, and its completed phase's outputs still addressable.
 *   4. Frozen pin — suspended and pinned to `Ship pipeline` version 1 while that
 *      definition's latest is version 3. Its park shares the attention key with the
 *      parked run, which is what gives the fold two runs to fold.
 *
 * EVERY RUN STARTS AFTER THE SESSION DOES. A run is owned by the session it belongs
 * to, so no instant in this table precedes the creation beat in `scenarios/workflows.ts`
 * — the ordering that scenario's header states and its suite holds.
 *
 * WHAT THIS TABLE CANNOT SAY. A phase's readable NAME. `WorkflowPhaseState` carries
 * `phaseId` and no name, and neither the run read nor the definition enumeration
 * carries one — the name lives in the definition BODY that `workflow.versionRead`
 * serves, which is one of the four registered workflow methods the growth row does
 * not carry. A surface needing a phase name today has an id and an honest absence.
 */
export const WORKFLOWS_SCENARIO_RUNS: readonly WorkflowRunSnapshot[] = [
  {
    workflowRunId: RUN_WORKING,
    sessionId: WORKFLOWS_SESSION_ID,
    workflowVersionId: VERSION_RELEASE_CHECKS_LATEST,
    state: "running",
    startedAt: "2026-01-01T09:52:00.000Z",
    phaseStates: [
      {
        phaseId: PHASE_DRAFT,
        phaseRunId: "019b7a10-0280-7aa1-8100-701a11150001",
        attemptNumber: 1,
        state: "completed",
        gateState: "open",
      },
      {
        phaseId: PHASE_BUILD,
        phaseRunId: "019b7a10-0280-7aa1-8100-701a11150002",
        // A second attempt, so a retry reads as a sub-entry rather than as the only
        // attempt there ever was. The per-phase retry bound is three by default.
        attemptNumber: 2,
        state: "running",
        gateState: "closed",
      },
      { phaseId: PHASE_REVIEW, state: "pending", gateState: "closed" },
    ],
  },
  WORKFLOWS_PARKED_RUN,
  {
    workflowRunId: RUN_CANCELLED,
    sessionId: WORKFLOWS_SESSION_ID,
    workflowVersionId: VERSION_INCIDENT_TRIAGE_LATEST,
    state: "cancelled",
    // The cancellation reason travels on `failureReason` — the contract's own split,
    // where that member is preserved on any bound breach AND carries the reason a
    // cancel supplied. A second member for it would be the console inventing one.
    failureReason: "Cancelled: the incident was resolved out of band.",
    startedAt: "2026-01-01T08:47:00.000Z",
    endedAt: "2026-01-01T09:04:00.000Z",
    phaseStates: [
      {
        phaseId: PHASE_DRAFT,
        phaseRunId: "019b7a10-0280-7aa1-8100-701a11150006",
        attemptNumber: 1,
        state: "completed",
        gateState: "open",
      },
      // Skipped rather than failed: a cancel stops what has not started rather than
      // failing it, and the two read very differently to somebody scanning a run
      // that will not move again.
      { phaseId: PHASE_REVIEW, state: "skipped", gateState: "closed" },
    ],
  },
  {
    workflowRunId: RUN_FROZEN_PIN,
    sessionId: WORKFLOWS_SESSION_ID,
    // Version 1 of `Ship pipeline`, whose latest above is version 3. The
    // frozen-definition state is exactly that inequality and nothing else.
    workflowVersionId: VERSION_SHIP_PIPELINE_PINNED,
    state: "suspended",
    startedAt: "2026-01-01T07:12:00.000Z",
    phaseStates: [
      {
        phaseId: PHASE_DRAFT,
        phaseRunId: "019b7a10-0280-7aa1-8100-701a11150007",
        attemptNumber: 1,
        state: "completed",
        gateState: "open",
      },
      {
        phaseId: PHASE_BUILD,
        phaseRunId: "019b7a10-0280-7aa1-8100-701a11150008",
        attemptNumber: 3,
        state: "running",
        gateState: "closed",
        parkReason: "provider-usage-limited",
        parkCause:
          "The provider account reached its weekly usage window. No reset boundary was reported, so no resume is scheduled.",
        // Deliberately no `autoResumeAt`. A usage-limit park with no armed instant is
        // the case a banner must read as parked awaiting resume rather than as
        // scheduled — a client that invented a time here would be the display half of
        // a guess the engine refused to make.
        parkAttentionKey: PARK_ATTENTION_KEY,
      },
    ],
  },
];

/**
 * The outputs `workflow.phaseOutputRead` answers for the parked run's finished phase.
 *
 * Both value kinds, because they render differently and a fixture carrying one would
 * leave the other undrawn: an inline summary a surface shows verbatim, and an artifact
 * reference a surface links rather than renders. `valueKind` is stated on both rather
 * than left to the presence of `artifactId`, which is the older daemon's fallback
 * reading and not the shape this fixture models.
 */
export const WORKFLOWS_SCENARIO_PHASE_OUTPUTS: readonly WorkflowPhaseOutput[] = [
  {
    valueKind: "inline",
    summary: "Release notes drafted for 14 merged pull requests across 3 packages.",
    producedAt: "2026-01-01T09:38:00.000Z",
  },
  {
    valueKind: "artifact_ref",
    artifactId: "019b7a10-0280-7ab2-8100-a2711fac0001",
    summary: "changelog.md",
    producedAt: "2026-01-01T09:38:00.000Z",
  },
];
