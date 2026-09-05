// What the fixture answers a WORKFLOW read with, and what it refuses to invent.
//
// Lifted out of `fixture-growth-port.ts` beside `fixture-workflow-scope.ts`, on the
// precedent that port set for `fixture-session-directory.ts` and
// `fixture-scripted-answer.ts`: the four handlers here and the reasoning that governs
// them are one unit with one subject, and holding them in the port took it past the
// package's split threshold. The port keeps the DECISION — which operations are
// served at all — and spreads this module's four answers into its served set.
//
// WHY THE FOUR READS ARE SERVED, AND WHY TWO OF THEM STILL REFUSE
//
// The workflows scenario scripts the four reads the destination, the run list, the
// run pane, and the definition browser are built on, and the growth port routed none
// of them. Three are keyed on their registered wire method; the run enumeration is
// keyed on its growth operation id, because its ledger row registers no method and
// the handler below says why. So the panes rendered the "not checked" refusal in every
// fixture build and the family's screenshots pinned an absence rather than the story
// the scenario tells. Routing them is what makes a script that already exists
// reachable.
//
// All four cross the same scripted-reply seam the branch-context read does, so a
// workflow read gets the frozen clock's loading window and the two non-arrival
// refusals a real read has. Where they part is the UNSCRIPTED arm, and the split is
// a property of the value rather than a preference:
//
//   • The two ENUMERATIONS answer with an empty list. A context that resolves no
//     definitions, and a session holding no runs, are both the EMPTY kind of nothing
//     (`Spec-023 §Console Design (Meridian)` §The five kinds of nothing) — a stated
//     fact a surface draws — and an empty enumeration is a real daemon answer to the
//     question asked. No `nextCursor` travels with the definitions, on the scripted
//     reply's own reasoning: a `result`-shaped reply is one fixed value the engine
//     finds by call name, so a cursor would promise a second page that every later
//     fetch would answer with this same one forever.
//   • The run read and the phase-output read refuse. Neither value has an empty form
//     — every member of `WorkflowRunSnapshot` is required, and a phase-output read
//     reports a phase that reached a terminal state — so the only way to answer would
//     be to invent a run and a finished phase, and a run pane offers operator
//     controls on whatever it is handed. They take the same "not checked" refusal
//     `callerParticipantRead` takes for a scenario that names no viewer: the question
//     reached nothing that could answer it.
//
// EVERY WORKFLOW READ CHECKS WHAT IT WAS ADDRESSED BY BEFORE IT ANSWERS. A scripted
// reply is matched by CALL NAME, so a handler that only forwarded the request answered
// `workflow.runRead` for ANY run id with the one run a scenario's FIXED value states,
// and both enumerations for any session with that session's rows. That is one
// session's workflow data displayed under another session's name, and a parked run
// returned for a run that is not it — a fixture teaching a surface that the daemon
// does not scope its answers. The scope check lives beside the port in
// `fixture-workflow-scope.ts`, which reads it out of the replies themselves.
//
// A scenario answering a snapshot read PER REQUEST needs no such holding, and gets
// none: `ScenarioReply`'s `resultFor` arm is handed the request, so it picks its own
// answer and refuses a subject it holds nothing for through the same constructor the
// scope module owns. The derivation finds no declared id on a computed reply and the
// check below passes through, which is why the refusal a caller meets is the same one
// under both reply shapes. The shipped workflows scenario answers both snapshot reads
// that way, so the four runs its enumeration lists are all openable.
//
// The two kinds of read part company over the same thing they part company over
// above: whether the value has an empty form.
//
//   • The two ENUMERATIONS are session-scoped, and a session this scenario is not
//     playing is answered with the EMPTY enumeration rather than with a refusal or
//     with this scenario's rows. That is `attentionProjectionRead`'s rule one
//     function up, and for the same reason: the operation IS served and what it
//     found for that session here is nothing.
//   • The two SNAPSHOT reads have no empty form, so an out-of-scope run or phase is
//     REFUSED with the daemon's own registered code. The refusal is a
//     `WireErrorEnvelope` thrown verbatim, which is the shape a SCRIPTED daemon
//     refusal already takes through this seam and the shape the live bridge will
//     throw the day these become ordinary calls. `workflow.not_found` is the workflow
//     namespace's only registered not-found row; minting a run-scoped one here would
//     be a fixture teaching a surface a code the corpus does not register, which is
//     the one thing a fixture must never do.
//
// NO MUTATION IS ROUTED, and that is the scenario's rule rather than this module's: a
// scripted reply is a fixed value and not a state machine, so a cancel that answered
// would sit beside a run read still reporting `suspended`. The six workflow
// operations this leaves — five mutations and the gate-chain verification — keep
// refusing under both bridges.
//

import { answerFromScriptedReply } from "./fixture-scripted-answer.js";
import { declaredWorkflowScope, requireScenarioWorkflowSubject } from "./fixture-workflow-scope.js";
import { growthUnavailable, type GrowthPort } from "./growth-port.js";
import type { ScenarioEngine } from "./scenario-engine.js";

/**
 * The workflow operations the fixture answers rather than refuses.
 *
 * Declared here and spread into `FIXTURE_SERVED_GROWTH_OPERATION_IDS` next door, so
 * the four ids and the four implementations below are one set with one home — a
 * second tuple in the port would agree with this one until a fifth read landed in
 * only one of them.
 */
export const FIXTURE_SERVED_WORKFLOW_OPERATION_IDS = [
  "workflowDefinitionList",
  "workflowRunRead",
  "workflowPhaseOutputRead",
  "workflowRunList",
] as const;

/** One workflow operation the fixture serves. Derived, so the set has one home. */
export type FixtureServedWorkflowOperationId =
  (typeof FIXTURE_SERVED_WORKFLOW_OPERATION_IDS)[number];

/**
 * The fixture's four workflow answers for one running scenario.
 *
 * `Pick` over the port rather than a shape of its own, so a handler whose signature
 * drifts from the operation it serves is a compile error here rather than a surface
 * rendering a value no daemon sends.
 */
export function fixtureWorkflowReads(
  engine: ScenarioEngine,
): Pick<GrowthPort, FixtureServedWorkflowOperationId> {
  return {
    workflowDefinitionList: async (request) => {
      // Served empty on BOTH out-of-scope arms — a scenario that scripts nothing, and
      // a session this scenario is not playing. An enumeration has an empty form and
      // it is a real answer, so the browser draws the EMPTY kind of nothing rather
      // than the "not checked" kind; what it must never draw is another session's
      // definitions under the session a person is looking at. `nextCursor` stays
      // absent, the scripted reply's own note beside it saying why.
      const emptyEnumeration = { status: "served", value: { definitions: [] } } as const;
      if (request.sessionId !== engine.scenario.sessionId) {
        return emptyEnumeration;
      }
      return answerFromScriptedReply(
        engine,
        "workflow.definitionList",
        "workflowDefinitionList",
        request,
        () => emptyEnumeration,
      );
    },
    workflowRunRead: async (request) => {
      // The runs this scenario can project are the ones its own reply answers for, and
      // the reply is where that is read from rather than a second copy kept beside it.
      // Any other run id is one this fixture holds no snapshot for, and answering it
      // from the scripted reply would put one run's phases, parks and controls on
      // screen under another run's name. A reply that answers per request scopes
      // itself, so this holds a FIXED one and passes a computed one through.
      requireScenarioWorkflowSubject(
        declaredWorkflowScope(engine.scenario).snapshotRunId,
        request.workflowRunId,
        "run",
      );
      // Refused for a scenario that scripts nothing, and the split from the read above
      // is the value's rather than this module's: `WorkflowRunSnapshot` requires a run
      // id, a session, a pinned version, a state, and a start instant, so an "empty"
      // run would be five invented facts, and a pane offers controls on what it holds.
      return answerFromScriptedReply(engine, "workflow.runRead", "workflowRunRead", request, () =>
        growthUnavailable("workflowRunRead"),
      );
    },
    workflowPhaseOutputRead: async (request) => {
      // Both identifiers, because the read is addressed by both: the outputs a
      // scenario states belong to one phase of one run, and either id arriving
      // different is a read this fixture cannot answer. Served under the wrong run, a
      // completed phase's outputs would read as that run's work. A scenario whose
      // outputs reply is computed pins both identifiers itself, for the same reason
      // the run read above does.
      const scope = declaredWorkflowScope(engine.scenario);
      requireScenarioWorkflowSubject(scope.snapshotRunId, request.workflowRunId, "run");
      requireScenarioWorkflowSubject(scope.phaseOutputPhaseId, request.phaseId, "phase");
      // Refused on the same ground. This read reports a phase that reached a terminal
      // state, so there is no phase the fixture could name here without stating that
      // a phase it knows nothing about has finished and left outputs behind.
      return answerFromScriptedReply(
        engine,
        "workflow.phaseOutputRead",
        "workflowPhaseOutputRead",
        request,
        () => growthUnavailable("workflowPhaseOutputRead"),
      );
    },
    workflowRunList: async (request) => {
      // Session-scoped exactly as the definition enumeration is, and empty on both
      // out-of-scope arms for the same reason: an enumeration HAS an empty form and
      // it is a real answer — this session holds no runs here — while this scenario's
      // four runs served under a session that owns none of them is a list of runs a
      // person cannot open, cancel, or account for.
      const emptyEnumeration = { status: "served", value: { runs: [] } } as const;
      if (request.sessionId !== engine.scenario.sessionId) {
        return emptyEnumeration;
      }
      // The one call name here that is NOT a wire method, and it says so: this
      // operation's ledger row registers none, so the scripted reply is keyed on the
      // operation id under a `growth:` prefix no daemon method can wear. The three
      // reads above transcribe registered method names; this one has nothing to
      // transcribe, and inventing a plausible-looking string would be the fixture
      // teaching a surface a wire fact traceable to nothing.
      return answerFromScriptedReply(
        engine,
        "growth:workflowRunList",
        "workflowRunList",
        request,
        () => emptyEnumeration,
      );
    },
  };
}
