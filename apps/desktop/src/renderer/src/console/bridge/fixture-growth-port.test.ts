// What the fixture serves, and that its claim about it is true.
//
// Two claims travel separately and have to agree: the port ANSWERS two operations,
// and the bridge PUBLISHES a set naming them. The composition root reads the set
// synchronously to decide whether to build a registry that can read at all, so a
// set that over-claims would have the console bind a stream to a store nothing can
// initialise, and a set that under-claims would leave the whole store layer dormant
// against a fixture that was ready to feed it. Neither failure is visible in a
// surface: both render as a console that quietly shows nothing.
//
// So every operation on the port is called, and each answer is checked against the
// set rather than against a list retyped here.

import { describe, expect, it } from "vitest";

import type { AttentionItem } from "./attention-projection.js";
import { createFixtureBridge } from "./fixture-bridge.js";
import { FIXTURE_SERVED_GROWTH_OPERATION_IDS } from "./fixture-growth-port.js";
import type { GrowthOperationId } from "./growth-entry.js";
import { GROWTH_OPERATIONS } from "./growth-operations.js";
import type { GrowthOutcome } from "./growth-outcome.js";
import type { GrowthPort } from "./index.js";
import { createLiveBridge } from "./live-bridge.js";
import type { ConsoleScenario, ScenarioBeat } from "./scenario.js";
import { FIRST_RUN_SCENARIO } from "./scenarios/first-run.js";
import { FLAGSHIP_SCENARIO } from "./scenarios/flagship.js";
import { CONSOLE_SCENARIOS } from "./scenarios/index.js";
import { REPOS_SCENARIO } from "./scenarios/repos.js";
import { findScenarioWireTruthDefects } from "./scenarios/wire-truth.js";
import { createTier1Bridge } from "@ai-sidekicks/contracts";

/**
 * Call one operation without knowing its request shape.
 *
 * The alternative — a table of one request per operation retyped here — is a second
 * declaration of the signature table that would go stale the first time a request
 * grew a member. So one request is sent to every arm, and an arm that declares no
 * `sessionId` simply never reads the member.
 *
 * The session is the scenario's OWN, and that is load-bearing rather than tidy: a
 * served operation may legitimately scope its answer to the session it is playing —
 * `callerParticipantRead` does, because an identity is a fact about one roster — so
 * a probe carrying no session would be asking about a session the fixture is not
 * playing and would read a correct scoping refusal as a broken served claim.
 */
async function callOperation(
  port: GrowthPort,
  operationId: GrowthOperationId,
): Promise<GrowthOutcome<unknown>> {
  const call = port[operationId] as (request: unknown) => Promise<GrowthOutcome<unknown>>;
  return call({ sessionId: FLAGSHIP_SCENARIO.sessionId });
}

function fixturePort(): GrowthPort {
  const bridge = createFixtureBridge({ scenario: FLAGSHIP_SCENARIO });
  return bridge.growth;
}

describe("the fixture growth port — what it serves, and what it still refuses", () => {
  it("answers every operation its bridge claims to serve, and refuses every other", async () => {
    const bridge = createFixtureBridge({ scenario: FLAGSHIP_SCENARIO });
    const served = new Set<string>(FIXTURE_SERVED_GROWTH_OPERATION_IDS);

    for (const operationId of Object.keys(GROWTH_OPERATIONS) as GrowthOperationId[]) {
      const outcome = await callOperation(bridge.growth, operationId);
      expect(outcome.status, `${operationId} answered the wrong way`).toBe(
        served.has(operationId) ? "served" : "unavailable",
      );
    }
  });

  it("publishes exactly the set it serves, so the synchronous decision is the true one", () => {
    const bridge = createFixtureBridge({ scenario: FLAGSHIP_SCENARIO });

    expect([...bridge.growthServedOperations].sort()).toStrictEqual(
      [...FIXTURE_SERVED_GROWTH_OPERATION_IDS].sort(),
    );
  });

  it("negative control: the live bridge serves none of them and names each one's own row", async () => {
    // Without this the sweep above would hold over a port that served everything.
    // The live arm is the one a release build takes, and it must still render the
    // `not-checked` absence for every wire the fixture answers.
    //
    // The expected row is read from the ledger rather than written out here. A
    // literal would have been right for exactly as long as the served set drew on
    // one slate row, and the assertion it makes — that a refusal attributes to the
    // row that owes ITS wire — is the ledger's claim, not this file's.
    const bridge = createLiveBridge(createTier1Bridge());

    expect([...bridge.growthServedOperations]).toStrictEqual([]);
    for (const operationId of FIXTURE_SERVED_GROWTH_OPERATION_IDS) {
      const outcome = await callOperation(bridge.growth, operationId);
      expect(outcome.status).toBe("unavailable");
      if (outcome.status === "unavailable") {
        expect(outcome.code).toBe("wire-unregistered");
        expect(outcome.slateRow).toBe(GROWTH_OPERATIONS[operationId].slateRow);
      }
    }
  });

  it("reads the base state a store can actually be initialised from", async () => {
    const port = fixturePort();

    const outcome = await port.sessionRead({ sessionId: FLAGSHIP_SCENARIO.sessionId });

    expect(outcome.status).toBe("served");
    if (outcome.status === "served") {
      // Cursor zero, so the store admits the scenario's first beat rather than
      // discarding a stream that starts below its base state.
      expect(outcome.value.cursor).toBe(0);
      expect(outcome.value.participantJoinLog).toStrictEqual(
        FLAGSHIP_SCENARIO.participantIdsInJoinOrder,
      );
    }
  });

  it("lends no session's join order to another, hue allocation keying on it", async () => {
    const port = fixturePort();

    const outcome = await port.sessionRead({ sessionId: "session-somebody-else" });

    expect(outcome.status).toBe("served");
    if (outcome.status === "served") {
      expect(outcome.value.participantJoinLog).toStrictEqual([]);
    }
  });

  it("lists the scenario's session, and names it by its identifier rather than inventing one", async () => {
    const port = fixturePort();

    const outcome = await port.sessionList({});

    expect(outcome.status).toBe("served");
    if (outcome.status === "served") {
      // The state is the one the scenario's own `session.read` reply declares,
      // read rather than assumed: the port used to hardcode `active` on the
      // premise that "a scenario plays one live session", which is exactly the
      // premise the first-run scenario is a counterexample to.
      expect(outcome.value).toStrictEqual([
        { sessionId: FLAGSHIP_SCENARIO.sessionId, state: "active" },
      ]);
    }
  });

  it("answers a first run with an empty directory, because it has no session yet", async () => {
    // The defect this replaces: the directory answered with the scenario's session
    // unconditionally, so the FIRST-RUN scenario — a fresh install whose whole
    // purpose is "no sessions, no agents, no history" — listed a session row on the
    // one surface whose committed screenshot baselines exist to pin the EMPTY kind
    // of nothing (`Spec-023 §Console Design (Meridian)` §The five kinds of nothing).
    //
    // Derived from what the scenario DECLARES rather than from which scenario it is:
    // first-run's `session.read` reply says `provisioning`, which is a session still
    // being created and not one the node has.
    const bridge = createFixtureBridge({ scenario: FIRST_RUN_SCENARIO });

    const outcome = await bridge.growth.sessionList({});

    expect(outcome.status).toBe("served");
    if (outcome.status === "served") {
      // Served-and-empty, not refused: the operation IS answered here, and what it
      // found is nothing. A refusal would render `not-checked`, which says the
      // console never asked.
      expect(outcome.value).toStrictEqual([]);
    }
  });

  it("carries the declared state through rather than relabelling it", async () => {
    // The negative control for the rule above. A port that simply answered empty
    // for every scenario, or that kept hardcoding one state, would satisfy the two
    // cases above; driving a scenario that declares a directory state OTHER than
    // `active` is what separates "read from the reply" from either.
    const pausedScenario: ConsoleScenario = {
      ...FIRST_RUN_SCENARIO,
      id: "first-run-paused-probe",
      replies: FIRST_RUN_SCENARIO.replies.map((reply) =>
        reply.call === "session.read"
          ? {
              call: "session.read",
              result: {
                session: {
                  id: FIRST_RUN_SCENARIO.sessionId,
                  state: "paused",
                  config: {},
                  metadata: {},
                  createdAt: FIRST_RUN_SCENARIO.startedAtIso,
                  updatedAt: FIRST_RUN_SCENARIO.startedAtIso,
                },
                timelineCursors: { latest: "first-run-cursor-1" },
              },
            }
          : reply,
      ),
    };
    const bridge = createFixtureBridge({ scenario: pausedScenario });

    const outcome = await bridge.growth.sessionList({});

    expect(outcome.status).toBe("served");
    if (outcome.status === "served") {
      expect(outcome.value).toStrictEqual([
        { sessionId: pausedScenario.sessionId, state: "paused" },
      ]);
    }
  });
});

// The attention plane's own suite.
//
// It sits apart from the sweep above because its subject is different: the sweep
// checks WHICH operations answer, and these check WHAT the answer says. The
// projection is the one served value the console must not compute for itself
// (Plan-019 I-019-4), so a fixture that answered plausibly-but-wrongly would train
// every attention surface against a projection no daemon will ever send.
//
// The flagship arm is honestly empty, which on its own would pass over a port that
// returned `[]` for everything. So the derivation is driven over scenarios built
// here that DO reach an attention state — held to the same wire-truth predicate the
// shipped scenarios are held to, `findScenarioWireTruthDefects`, so the beats are
// events a daemon can emit rather than plausible-looking inventions.

const ATTENTION_SESSION_ID = "019b7a11-0280-75e5-8510-ada11a5a33a5";
const ATTENTION_PARTICIPANT_ID = "019b7a11-0280-79a4-8110-cca0117a0330";
const RUN_AWAITING_APPROVAL = "019b7a11-0280-740e-8110-d1a4c1150021";
const RUN_FINISHED = "019b7a11-0280-740e-8120-d1a4c1150022";

/** One run state transition, in the shape the shipped scenarios script them. */
function runTransition(
  atMs: number,
  sequence: number,
  runId: string,
  previousState: string,
  newState: string,
): ScenarioBeat {
  return {
    atMs,
    event: {
      sessionId: ATTENTION_SESSION_ID,
      sequence,
      kind: `run.${newState}`,
      occurredAt: new Date(Date.parse("2026-01-01T16:00:00.000Z") + atMs).toISOString(),
      payload: {
        sessionId: ATTENTION_SESSION_ID,
        runId,
        runVersion: sequence,
        previousState,
        newState,
      },
    },
  };
}

/**
 * A session whose two runs reach two different attention states.
 *
 * One run waits for an approval and one finishes, so the projection has to carry an
 * actionable contributor and an informational one at once — which is the only shape
 * in which the aggregate's severity rule and its representative-selection rule can
 * both be wrong without the other noticing.
 */
function twoRunAttentionScenario(extraBeats: readonly ScenarioBeat[] = []): ConsoleScenario {
  return {
    id: "attention-two-runs",
    label: "Two runs, two kinds of attention",
    purpose:
      "Drives the fixture's attention derivation over an actionable and an informational contributor.",
    sessionId: ATTENTION_SESSION_ID,
    participantIdsInJoinOrder: [ATTENTION_PARTICIPANT_ID],
    startedAtIso: "2026-01-01T16:00:00.000Z",
    beats: [
      runTransition(100, 1, RUN_FINISHED, "running", "completed"),
      runTransition(200, 2, RUN_AWAITING_APPROVAL, "running", "waiting_for_approval"),
      ...extraBeats,
    ],
    replies: [],
  };
}

/** The port and the engine for one scenario, so a test can advance playback itself. */
function playScenario(scenario: ConsoleScenario): {
  readonly port: GrowthPort;
  readonly advanceToEnd: () => void;
} {
  const bridge = createFixtureBridge({ scenario });
  const engine = bridge.scenarioEngine;
  if (engine === undefined) {
    throw new Error("the fixture bridge built no scenario engine");
  }
  return { port: bridge.growth, advanceToEnd: () => engine.runToCompletion() };
}

/** The served projection's items, or a failure naming the refusal instead. */
async function readAttentionItems(
  port: GrowthPort,
  sessionId: string,
): Promise<readonly AttentionItem[]> {
  const outcome = await port.attentionProjectionRead({ sessionId });
  if (outcome.status !== "served") {
    throw new Error(`the fixture refused the attention read: ${outcome.detail}`);
  }
  return outcome.value.items;
}

describe("the fixture's attention projection — derived from the scenario, never invented", () => {
  it("serves an empty projection for the flagship, whose runs never reach an attention state", async () => {
    // Honest emptiness, not a stub: the flagship's newest run transition is
    // `starting`, which `Spec-019 §Default Behavior` classifies as neither
    // actionable nor informational. The scenario is read for that fact here rather
    // than asserted about, and the cases below prove the fold is not simply inert.
    const { port, advanceToEnd } = playScenario(FLAGSHIP_SCENARIO);
    advanceToEnd();

    const newestRunState = FLAGSHIP_SCENARIO.beats
      .map((beat) => beat.event.payload?.["newState"])
      .filter((state): state is string => typeof state === "string")
      .at(-1);

    expect(newestRunState).toBe("starting");
    expect(await readAttentionItems(port, FLAGSHIP_SCENARIO.sessionId)).toStrictEqual([]);
  });

  it("scripts beats a daemon can actually emit, so the cases below are not about a fake wire", () => {
    expect(findScenarioWireTruthDefects([twoRunAttentionScenario()])).toStrictEqual([]);
  });

  it("derives one item per run in an attention state, with the severity the spec assigns", async () => {
    const { port, advanceToEnd } = playScenario(twoRunAttentionScenario());
    advanceToEnd();

    const items = await readAttentionItems(port, ATTENTION_SESSION_ID);
    const byRunId = new Map(
      items.filter((item) => item.runId !== undefined).map((item) => [item.runId, item]),
    );

    expect(byRunId.get(RUN_AWAITING_APPROVAL)).toMatchObject({
      trigger: "pending_approval",
      severity: "actionable",
      sessionId: ATTENTION_SESSION_ID,
    });
    expect(byRunId.get(RUN_FINISHED)).toMatchObject({
      trigger: "run_completed",
      severity: "informational",
    });
    // The canonical event each item came from, keyed the way the console keys
    // events. Asserted against the scenario's own beat rather than a literal.
    expect(byRunId.get(RUN_AWAITING_APPROVAL)?.sourceEventId).toBe(`${ATTENTION_SESSION_ID}:2`);
  });

  it("carries the session aggregate as the item with no run, actionable while any contributor is", async () => {
    const { port, advanceToEnd } = playScenario(twoRunAttentionScenario());
    advanceToEnd();

    const items = await readAttentionItems(port, ATTENTION_SESSION_ID);
    const aggregate = items.find((item) => item.runId === undefined);
    const actionableContributor = items.find(
      (item) => item.runId !== undefined && item.severity === "actionable",
    );

    expect(aggregate).toBeDefined();
    // One actionable contributor out of two makes the aggregate actionable, and the
    // representative is that contributor — highest severity first. Both halves are
    // read off the contributors rather than restated as literals, so the assertion
    // fails if the aggregate ever names the informational one.
    expect(aggregate?.severity).toBe("actionable");
    expect(aggregate?.trigger).toBe(actionableContributor?.trigger);
    expect(aggregate?.sourceEventId).toBe(actionableContributor?.sourceEventId);
  });

  it("resolves an item when its run leaves the attention state, and drops the aggregate with the last one", async () => {
    // The resolution half. Without it the fold would be append-only and a session
    // would stay actionable forever after one approval request.
    const resolved = twoRunAttentionScenario([
      runTransition(300, 3, RUN_AWAITING_APPROVAL, "waiting_for_approval", "running"),
    ]);
    const { port, advanceToEnd } = playScenario(resolved);
    advanceToEnd();

    const items = await readAttentionItems(port, ATTENTION_SESSION_ID);

    expect(items.filter((item) => item.runId === RUN_AWAITING_APPROVAL)).toStrictEqual([]);
    // The finished run still contributes, so the aggregate survives and downgrades
    // rather than vanishing — a vanished aggregate would read as "nothing happened".
    expect(items.find((item) => item.runId === undefined)?.severity).toBe("informational");
  });

  it("reflects playback position, so attention arrives as the frozen clock reaches it", async () => {
    const { port, advanceToEnd } = playScenario(twoRunAttentionScenario());

    const beforeAnyBeat = await readAttentionItems(port, ATTENTION_SESSION_ID);
    advanceToEnd();
    const afterEveryBeat = await readAttentionItems(port, ATTENTION_SESSION_ID);

    // A projection computed from the whole script would be identical at both
    // points, which is exactly the fixture that cannot show a surface a state
    // arriving.
    expect(beforeAnyBeat).toStrictEqual([]);
    expect(afterEveryBeat.length).toBeGreaterThan(0);
  });

  it("answers for a session it is not playing, and answers that there is nothing", async () => {
    const { port, advanceToEnd } = playScenario(twoRunAttentionScenario());
    advanceToEnd();

    const outcome = await port.attentionProjectionRead({ sessionId: FLAGSHIP_SCENARIO.sessionId });

    // Served, not refused: the operation IS answered here, and what it found for
    // another session is nothing. A refusal would say the wire is missing, which
    // under this bridge is false.
    expect(outcome.status).toBe("served");
    if (outcome.status === "served") {
      expect(outcome.value.items).toStrictEqual([]);
    }
  });

  it("refuses the preference pair, which no store backs under either bridge", async () => {
    const { port } = playScenario(twoRunAttentionScenario());

    for (const outcome of [
      await port.attentionPreferenceRead({ participantId: ATTENTION_PARTICIPANT_ID }),
      await port.attentionPreferenceUpdate({
        participantId: ATTENTION_PARTICIPANT_ID,
        key: "mute-all",
        value: { enabled: true },
      }),
    ]) {
      expect(outcome.status).toBe("unavailable");
      if (outcome.status === "unavailable") {
        expect(outcome.slateRow).toBe("attention-plane");
        expect(outcome.owningDocument).toContain("Spec-019");
      }
    }
  });
});

// The gitflow reads.
//
// `Spec-011 §Interfaces And Contracts` puts two operations in front of the repos
// surfaces — a branch-context read and a PR preparation — and the console had a
// port entry for neither, so a branch-context summary built against the fixture
// had to invent the shape inside a view family, which is the thing the growth port
// exists to prevent.
//
// The subject of these cases is the DISTINCTION the two of them draw. One is
// served and answers that there is nothing; the other refuses. Those are two
// different kinds of nothing (`Spec-023 §Console Design (Meridian)`), a summary
// renders them differently, and a port that collapsed them would let the surface
// ship having only ever been driven through one.

/**
 * Names a member that would only appear if a scenario stated a branch.
 *
 * The two `BranchContextReadResponse` requires and cannot be derived from anything
 * a scenario plays, plus the id that would name a context outright and the
 * request-side name a scenario would script one under.
 */
const BRANCH_NAMING_MEMBERS = [
  "branchContextId",
  "baseBranch",
  "headBranch",
  "branchName",
] as const;

/**
 * Scenarios that state a branch anywhere — in a beat's payload or a scripted reply.
 *
 * The fixture answers the branch-context read from the SCRIPT where a scenario has
 * one and from its own absence where none does, and this finder is what keeps the
 * second half honest rather than a restatement of it: no registered event payload
 * names a branch, so a scenario that scripts no `gitflow.branchContextRead` reply has
 * nothing anywhere for a derivation to read, and the absence is the true answer for
 * it. The repos scenario scripts one — which is why it is named below rather than
 * merely tolerated: a scenario that quietly stopped scripting it would leave the
 * proposal gate reachable only through the empty state again, and this assertion is
 * what fails at that moment.
 */
function findScenariosNamingABranch(scenarios: readonly ConsoleScenario[]): readonly string[] {
  return scenarios
    .filter((scenario) => {
      const serialised = JSON.stringify(scenario);
      return BRANCH_NAMING_MEMBERS.some((member) => serialised.includes(`"${member}"`));
    })
    .map((scenario) => scenario.id);
}

describe("the fixture's gitflow reads — one answers nothing, the other refuses", () => {
  it("plays exactly one scenario that states a branch, and every other takes the absence", () => {
    expect(findScenariosNamingABranch(CONSOLE_SCENARIOS)).toStrictEqual([REPOS_SCENARIO.id]);
  });

  it("negative control: reports a scenario that DOES state one", () => {
    // Scripted as a canned reply, because that is how a scenario would really state
    // a branch context — `gitflow.branchContextRead` is a request/response call and
    // no event payload in the census carries a branch name at all.
    const withBranchContext: ConsoleScenario = {
      ...FLAGSHIP_SCENARIO,
      id: "states-a-branch",
      replies: [
        {
          call: "gitflow.branchContextRead",
          result: { baseBranch: "develop", headBranch: "feature/topic" },
        },
      ],
    };

    expect(findScenariosNamingABranch([withBranchContext])).toStrictEqual(["states-a-branch"]);
  });

  it("serves the branch-context read, answering that this workspace has none", async () => {
    const port = fixturePort();

    const outcome = await port.gitflowBranchContextRead({
      workspaceId: "workspace-1",
      worktreeId: "worktree-1",
    });

    expect(outcome.status).toBe("served");
    if (outcome.status === "served") {
      expect(outcome.value.branchContext).toBeUndefined();
    }
  });

  it("keeps that absence distinct from the live bridge's not-checked refusal", async () => {
    // The two facts a repos summary has to tell apart. Under the fixture the read
    // happened and found nothing; under the live bridge nobody asked, and the
    // refusal names who owes the wire. A port that answered the same way under both
    // would let the summary ship rendering one state for two situations.
    const bridge = createLiveBridge(createTier1Bridge());

    const outcome = await bridge.growth.gitflowBranchContextRead({
      workspaceId: "workspace-1",
      worktreeId: "worktree-1",
    });

    expect(outcome.status).toBe("unavailable");
    if (outcome.status === "unavailable") {
      expect(outcome.slateRow).toBe("gitflow-actions");
      expect(outcome.owningDocument).toContain("Spec-011");
    }
    expect(outcome).not.toHaveProperty("value");
  });

  it("refuses the PR preparation under both bridges, no daemon standing behind it", async () => {
    const liveBridge = createLiveBridge(createTier1Bridge());
    const request = { branchContextId: "branch-context-1", targetBranch: "develop" };

    for (const outcome of [
      await fixturePort().gitflowPrPrepare(request),
      await liveBridge.growth.gitflowPrPrepare(request),
    ]) {
      expect(outcome.status).toBe("unavailable");
      if (outcome.status === "unavailable") {
        expect(outcome.slateRow).toBe("gitflow-actions");
        // A reviewable proposal is a daemon act — `Spec-011 §Required Behavior`
        // puts it before any remote mutation — so a fixture that answered would be
        // standing in for the review, not for the wire.
        expect(outcome.detail).toContain("not registered yet");
      }
    }
  });
});

// The identity read, and the two rows that still refuse under both bridges.
//
// The gitflow cases above are about a DISTINCTION — one operation served, one
// refused. These are about the other half of that discipline: an operation refuses
// when the scenario states nothing it could answer from, and the case that earns its
// place is not the refusal (the sweep at the top of this file already covers every
// operation's answer) but the PREMISE the refusal rests on. So each finder below
// asserts what no scenario says, and each has a negative control that plants it.
//
// The identity row is the one whose premise MOVED. `ConsoleScenario` grew
// `viewingParticipantId`, so the fact now has a home and the read is answered from
// it — and the premise worth pinning inverted with it: what no scenario may do is
// state a viewer under some OTHER name, because the port reads exactly one field and
// a second spelling would be a fact on the script that never reaches a surface. The
// sidekick row has no finder because its premise cannot go stale: a definition is
// node-local configuration and `ConsoleScenario` models no node at all, so there is
// no field a scenario could grow that would make one derivable.

/**
 * Names a scenario must NOT state a viewer under — the spellings that are not the
 * field the port reads.
 *
 * `viewingParticipantId` is deliberately absent from this list: it is the one name
 * the fixture answers from, and every substrate scenario now carries it. What the
 * finder catches is the near-miss — a family scenario that writes `viewerParticipantId`
 * into a scripted reply and quietly gets a refusal, because the port never looks
 * there. Not `participantIdsInJoinOrder` either, which every scenario carries and
 * which is deliberately not this fact: join order is who opened the session and who
 * followed, on any machine.
 */
const VIEWER_NAMING_MEMBERS = [
  "viewerParticipantId",
  "callerParticipantId",
  "selfParticipantId",
] as const;

/** Members a scenario would have to carry to state a registered callback tool. */
const CALLBACK_TOOL_NAMING_MEMBERS = ["callbackTools", "inputSchema"] as const;

/** Scenarios naming any of `members` anywhere — a beat payload or a scripted reply. */
function findScenariosNaming(
  scenarios: readonly ConsoleScenario[],
  members: readonly string[],
): readonly string[] {
  return scenarios
    .filter((scenario) => {
      const serialised = JSON.stringify(scenario);
      return members.some((member) => serialised.includes(`"${member}"`));
    })
    .map((scenario) => scenario.id);
}

describe("the fixture's identity read — answered from the field, refused without it", () => {
  it("answers which participant this window is, from the scenario's own statement", async () => {
    const port = fixturePort();

    const outcome = await port.callerParticipantRead({ sessionId: FLAGSHIP_SCENARIO.sessionId });

    expect(outcome.status).toBe("served");
    if (outcome.status === "served") {
      expect(outcome.value.participantId).toBe(FLAGSHIP_SCENARIO.viewingParticipantId);
      // In the roster, which is what makes the answer resolvable to a role. The
      // wire-truth predicate holds every scenario to this; the assertion here is
      // that the PORT answers with the member rather than with something adjacent.
      expect(FLAGSHIP_SCENARIO.participantIdsInJoinOrder).toContain(outcome.value.participantId);
    }
  });

  it("refuses for a scenario that states no viewer, rather than reading join order", () => {
    // The fabrication the field exists to prevent, asserted as a refusal rather
    // than argued in a comment: the head of the join order is right there and is
    // not the answer.
    const { viewingParticipantId: _statedViewer, ...withoutViewerFields } = FLAGSHIP_SCENARIO;
    const withoutViewer: ConsoleScenario = { ...withoutViewerFields, id: "states-no-viewer" };

    return expect(
      createFixtureBridge({ scenario: withoutViewer }).growth.callerParticipantRead({
        sessionId: withoutViewer.sessionId,
      }),
    ).resolves.toMatchObject({ status: "unavailable", code: "wire-unregistered" });
  });

  it("lends no session's viewer to another, a role being a fact about one roster", async () => {
    const port = fixturePort();

    const outcome = await port.callerParticipantRead({ sessionId: "session-somebody-else" });

    expect(outcome.status).toBe("unavailable");
    expect(outcome).not.toHaveProperty("value");
  });

  it("keeps that answer out of the live bridge, which still has no wire for it", async () => {
    const bridge = createLiveBridge(createTier1Bridge());

    const outcome = await bridge.growth.callerParticipantRead({
      sessionId: FLAGSHIP_SCENARIO.sessionId,
    });

    expect(outcome.status).toBe("unavailable");
    if (outcome.status === "unavailable") {
      expect(outcome.slateRow).toBe("caller-participant-identity");
      expect(outcome.owningDocument).toContain("Authenticated Principal");
    }
  });

  it("plays no scenario that states a viewer under a name the port does not read", () => {
    expect(findScenariosNaming(CONSOLE_SCENARIOS, VIEWER_NAMING_MEMBERS)).toStrictEqual([]);
  });

  it("negative control: reports a scenario that states one under the wrong name", () => {
    const withMisnamedViewer: ConsoleScenario = {
      ...FLAGSHIP_SCENARIO,
      id: "names-a-viewer",
      replies: [
        {
          call: "participant.projectionRead",
          result: { viewerParticipantId: FLAGSHIP_SCENARIO.participantIdsInJoinOrder[0] },
        },
      ],
    };

    expect(findScenariosNaming([withMisnamedViewer], VIEWER_NAMING_MEMBERS)).toStrictEqual([
      "names-a-viewer",
    ]);
  });
});

describe("the fixture's registry reads — refusing on a stated premise", () => {
  it("plays no scenario that states a registered callback tool", () => {
    expect(findScenariosNaming(CONSOLE_SCENARIOS, CALLBACK_TOOL_NAMING_MEMBERS)).toStrictEqual([]);
  });

  it("negative control: reports a scenario that DOES state one", () => {
    const withCallbackTools: ConsoleScenario = {
      ...FLAGSHIP_SCENARIO,
      id: "states-a-callback-tool",
      replies: [
        {
          call: "session.read",
          result: { callbackTools: [{ name: "workflow_start", inputSchema: {} }] },
        },
      ],
    };

    expect(findScenariosNaming([withCallbackTools], CALLBACK_TOOL_NAMING_MEMBERS)).toStrictEqual([
      "states-a-callback-tool",
    ]);
  });

  it("refuses all five under both bridges, each naming the row that owes its wire", async () => {
    const liveBridge = createLiveBridge(createTier1Bridge());
    const port = fixturePort();
    const rows = ["callback-tool-registry-read", "sidekick-definition-registry"];
    const operationIds = (Object.keys(GROWTH_OPERATIONS) as GrowthOperationId[]).filter(
      (operationId) => rows.includes(GROWTH_OPERATIONS[operationId].slateRow),
    );

    // Five, and the count is asserted so a row that quietly lost its operations
    // cannot make the loop below vacuously pass. The identity row is no longer
    // among them — it is answered above from the scenario's own field, which is
    // exactly the transition this count is here to notice.
    expect(operationIds).toHaveLength(5);
    for (const operationId of operationIds) {
      for (const outcome of [
        await callOperation(port, operationId),
        await callOperation(liveBridge.growth, operationId),
      ]) {
        expect(outcome.status, operationId).toBe("unavailable");
        if (outcome.status === "unavailable") {
          expect(outcome.slateRow, operationId).toBe(GROWTH_OPERATIONS[operationId].slateRow);
          // Not an empty list, an empty registry, or a null identity. Each of those
          // is a real daemon answer to a question nobody asked here, and a surface
          // handed one renders a checked state it never checked.
          expect(outcome.code, operationId).toBe("wire-unregistered");
        }
        expect(outcome, operationId).not.toHaveProperty("value");
      }
    }
  });

  it("names each row's owning document, so a reader knows who owes the wire", async () => {
    const port = fixturePort();

    for (const [operationId, owner] of [
      ["callbackToolRegistryRead", "Spec-005"],
      ["sidekickDefinitionList", "Spec-030"],
    ] as const) {
      const outcome = await callOperation(port, operationId);

      expect(outcome.status).toBe("unavailable");
      if (outcome.status === "unavailable") {
        expect(outcome.owningDocument, operationId).toContain(owner);
      }
    }
  });
});
