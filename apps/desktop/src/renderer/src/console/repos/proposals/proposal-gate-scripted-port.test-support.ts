// The scripted growth port every change-proposal gate case is driven against, the
// readers it opens, and the two drains that let a frozen clock settle.
//
// A SUPPORT MODULE RATHER THAN A COPY BESIDE EACH TEST, on
// `attachment-ingest-scripted-port.test-support.ts`'s precedent in this same family. The read half
// and the act half are tested beside the modules that own them, and both need the same
// scripted answers, the same manual clock, and the same disposal discipline — written
// twice they would drift, and two files asserting against two slightly different ports
// would read as if their results were comparable.
//
// The served-context case drives the REAL fixture bridge against the repos scenario,
// which scripts `gitflow.branchContextRead`; the cases the fixture cannot reach — a
// served preparation, a served-but-unaccepted act, a reply that never arrived — drive
// a hand-built port, because the fixture's served set does not carry the preparation
// call and a test that skipped those arms would leave the branching unchecked. Every
// clock is manual, so "the gate never polls" is read off `pendingCount` rather than
// asserted.

import { fixtureBridgeWithGrowth } from "../../bridge/fixture/fixture-bridge.test-support.js";
import {
  growthUnavailable,
  type ConsoleBridge,
  type GrowthPort,
  type GrowthUnavailable,
} from "../../bridge/index.js";
import type { GrowthPortAnswer, GrowthServedValue } from "../../bridge/growth-port/growth-port.js";
import { REPOS_SCENARIO } from "../../bridge/scenarios/repos.js";
import {
  GIT_MOUNT_ID,
  GIT_WORKSPACE_ID,
  IMPLEMENTER_WORKTREE_ID,
  PARTICIPANT_YOU,
} from "../../bridge/scenarios/repos-fixture-data.js";
import { ManualClock, REFRESH_DEBOUNCE_MS } from "../../core/index.js";
import { SessionStore } from "../../store/index.js";
import type { ProposalContextKey } from "./prepared-proposal.js";
import { ProposalGateReader } from "./proposal-gate-reader.js";
import type { ProposalGateSubject } from "./proposal-gate-model.js";

/** The one root the registered branch-context read has a key for. */
export const SUBJECT: ProposalGateSubject = {
  kind: "worktree",
  workspaceId: GIT_WORKSPACE_ID,
  // The mount an act names on the wire. The scenario's own, so a case asserting the
  // registered request is comparing against the id the fixture actually mounts.
  repoMountId: GIT_MOUNT_ID,
  worktreeId: IMPLEMENTER_WORKTREE_ID,
  executionMode: "worktree",
};

/** A read-only subject on the mount whose mode produces no writable context. */
export const READ_ONLY_SUBJECT: ProposalGateSubject = { ...SUBJECT, executionMode: "read-only" };

/**
 * The port's refusal for a wire nothing has registered — taken from the port itself.
 *
 * COMPOSED RATHER THAN COPIED. This was a hand-written twin of a sentence the live
 * bridge composes, and it had drifted into naming the governing document inside the
 * words a person reads — which is exactly what `growth-port.ts` composes to avoid: the
 * document travels on the refusal's own `owningDocument` member, for the ledger, and
 * the sentence stays product vocabulary. Written twice, the copy is free to say
 * something the live port never would, and every case here would still pass. Taken
 * from `growthUnavailable`, it cannot.
 */
export const WIRE_UNREGISTERED: GrowthUnavailable = growthUnavailable("gitflowBranchContextRead");

/**
 * The port's other refusal class: the question was put and the answer never came.
 *
 * COMPOSED from the same builder for `WIRE_UNREGISTERED`'s reason, and it also stops
 * the shape being wrong: a hand-written literal carried four members while the port's
 * own refusal carries seven, so a case comparing a rendered refusal against this one
 * was comparing against a value the port could never produce. The two members this
 * case IS about — the code and the sentence — are stated; the slate-derived rest comes
 * from the operation.
 */
export const REPLY_ABANDONED: GrowthUnavailable = {
  ...growthUnavailable("gitflowBranchContextRead"),
  code: "reply-abandoned",
  detail: "The scenario was torn down before the frozen clock reached this reply.",
};

/**
 * One served branch context, in the wire's own member names — the value alone, so a
 * case reading one member does not narrow the outcome first.
 *
 * FLAT, exactly as `BranchContextReadResponse` returns it: the context's fields ARE
 * the reply, and there is no envelope member to reach through.
 *
 * ANNOTATED RATHER THAN `as const`, because two of its members are the scenario's own
 * exported ids: `isolatedDeclarations` cannot infer a const-asserted literal that
 * reaches through an import, so the shape is stated here and the ids stay the
 * fixture's rather than being respelled.
 */
export const SERVED_CONTEXT_VALUE: GrowthServedValue<"gitflowBranchContextRead"> = {
  branchContextId: "019b7b30-0280-7c11-8420-b1a5c0de2301",
  workspaceId: GIT_WORKSPACE_ID,
  baseBranch: "develop",
  headBranch: "feat/rate-limit-wiring",
  upstreamRef: "origin/feat/rate-limit-wiring",
  worktreeId: IMPLEMENTER_WORKTREE_ID,
};

/** That context as the port answers it, which is what a scripted arm serves. */
export const SERVED_CONTEXT: GrowthPortAnswer<"gitflowBranchContextRead"> = {
  status: "served",
  value: SERVED_CONTEXT_VALUE,
};

/** A preparation the port serves, so a case can hold a proposal and then move the context. */
export const SERVED_PREPARATION: GrowthPortAnswer<"gitflowPrPrepare"> = {
  status: "served",
  value: {
    prPreparationId: "019b7b30-0280-7c11-8420-b1a5c0de2401",
    state: "ready",
    proposalBlob: { summary: "the rate limiter" },
  },
};

/**
 * What the daemon answers an act it took with. Named once because three cases send one.
 *
 * `success`, which is `GitActionExecuteResponse`'s own member. The `accepted` this used
 * to carry was never on that reply at all.
 */
export const ACCEPTED_ACTION: GrowthPortAnswer<"gitActionExecute"> = {
  status: "served",
  value: { success: true },
};

/** The identity the caller read answers with, so an act carries the fixture's causation. */
export const SERVED_CALLER_PARTICIPANT: GrowthPortAnswer<"callerParticipantRead"> = {
  status: "served",
  value: { participantId: PARTICIPANT_YOU },
};

/** One served context, with whichever of the pairing members a case wants moved. */
export function servedContext(
  overrides: Partial<ProposalContextKey>,
): GrowthPortAnswer<"gitflowBranchContextRead"> {
  return {
    status: "served",
    value: { ...SERVED_CONTEXT_VALUE, ...overrides },
  };
}

/**
 * A scripted answer that REJECTS rather than answering.
 *
 * THE SHAPE THE PORT'S OWN UNION CANNOT EXPRESS, which is why it is a marker class and
 * not another `status` arm: the live bridge crosses a process boundary, so an IPC
 * disconnect makes a call THROW, and a script whose every entry is a resolved value
 * could not put a case on that path at all. Held as a class rather than a sentinel
 * object so `instanceof` is the test and no scripted reply can be mistaken for one.
 */
export class ScriptedRejection {
  public constructor(public readonly reason: unknown) {}
}

/** Script one operation to reject with `reason`, the way a disconnected bridge does. */
export function rejectsWith(reason: unknown): ScriptedRejection {
  return new ScriptedRejection(reason);
}

/**
 * One scripted entry, answered or thrown.
 *
 * ONE DOOR FOR EVERY OPERATION on all three ports below, so a case can move any of
 * them onto the rejection path without a second port shape to keep in step.
 */
function scriptedAnswer(scripted: unknown): unknown {
  if (scripted instanceof ScriptedRejection) {
    throw scripted.reason;
  }
  return scripted;
}

/** What each of the four growth operations answers, for one case. */
export interface PortScript {
  readonly branchContext: unknown;
  readonly prepare?: unknown;
  readonly gitAction?: unknown;
  /**
   * The caller-identity read, which every case gets an answer to by default.
   *
   * Defaulted rather than required, because it is not what any case is about: an act
   * carries the caller's id as CAUSATION, so a case scripting only a git action still
   * needs the read to answer or it would be asserting against a request whose causation
   * went missing for a reason the case never stated. A case that wants the unread arm
   * scripts a refusal here deliberately.
   */
  readonly callerParticipant?: unknown;
}

/**
 * What each of the four arms answers, given the request it was sent.
 *
 * A SUPPLIER PER ARM RATHER THAN A VALUE, which is what lets the three exported ports
 * below be three callers of ONE construction instead of three copies of it. A fixed
 * script closes over its value, the recording port pushes the request before
 * answering, and the moving port reads a `let` the case reassigns — three behaviours,
 * one four-arm port, so a fifth operation is added in one place.
 */
interface PortSuppliers {
  readonly branchContext: () => unknown;
  readonly prepare: () => unknown;
  readonly gitAction: (request: unknown) => unknown;
  readonly callerParticipant: () => unknown;
}

/**
 * The REAL fixture bridge over the repos scenario, with these four arms spread on.
 *
 * Built through `fixtureBridgeWithGrowth` rather than as `{ growth: {…} } as unknown as
 * ConsoleBridge`, which is what all three of these ports used to be. Three things
 * change and each was a live defect: every other namespace is now the fixture's own
 * rather than `undefined`, so a gate that started reaching the daemon door fails an
 * assertion instead of throwing inside the case; an operation none of these four names
 * answers the fixture's own typed outcome rather than `undefined`, which a caller
 * narrowing on `status` reads as neither served nor refused; and the whole bridge type
 * is no longer erased.
 *
 * THE ONE CAST THAT REMAINS is `Partial<GrowthPort>` over the four arms, and it is
 * here because the bridge door deliberately publishes neither `GrowthOutcome` nor the
 * per-operation value types (`bridge/index.ts` says why: a view family writes the
 * served arm it consumes rather than importing the union). Typing these scripts against
 * the signature table is the substrate change that would remove it, and it is reported
 * rather than made here. It erases the four arms' payload shapes and nothing else.
 */
function gateBridge(suppliers: PortSuppliers): ConsoleBridge {
  const scriptedPort = {
    gitflowBranchContextRead: async () => scriptedAnswer(suppliers.branchContext()),
    gitflowPrPrepare: async () => scriptedAnswer(suppliers.prepare()),
    gitActionExecute: async (request: unknown) => scriptedAnswer(suppliers.gitAction(request)),
    callerParticipantRead: async () => scriptedAnswer(suppliers.callerParticipant()),
  } as Partial<GrowthPort>;
  return fixtureBridgeWithGrowth(REPOS_SCENARIO, scriptedPort);
}

/**
 * The four suppliers a FIXED script produces — the shape two of the three ports share.
 *
 * An arm the script leaves out answers the port's own unregistered-wire refusal rather
 * than an absent value, which is the same answer the repos scenario's fixture gives for
 * these two operations. Stated here so an unscripted arm is a refusal a case can render
 * rather than an `undefined` it silently narrows past.
 */
function suppliersFor(script: PortScript): PortSuppliers {
  return {
    branchContext: () => script.branchContext,
    prepare: () => script.prepare ?? growthUnavailable("gitflowPrPrepare"),
    gitAction: () => script.gitAction ?? growthUnavailable("gitActionExecute"),
    callerParticipant: () => script.callerParticipant ?? SERVED_CALLER_PARTICIPANT,
  };
}

/** A bridge whose growth port answers exactly what a case scripts. */
export function gateBridgeAnswering(script: PortScript): ConsoleBridge {
  return gateBridge(suppliersFor(script));
}

/** A bridge that keeps every git-action request it was sent, in the order they went. */
export interface RecordingPort {
  readonly bridge: ConsoleBridge;
  /** Every request `gitflow.gitActionExecute` was called with, wire-verbatim. */
  readonly gitActionRequests: () => readonly unknown[];
}

/**
 * A bridge that records what an act SENT rather than only what it answered.
 *
 * THE ONLY WAY TO ASSERT A REQUEST SHAPE. Every other port here scripts a reply and
 * discards the request, which is exactly why a call carrying a member the registered
 * contract does not have — and missing two it requires — passed every case in this
 * family: nothing had ever looked at the argument.
 */
export function recordingPort(script: PortScript): RecordingPort {
  const requests: unknown[] = [];
  const suppliers = suppliersFor(script);
  return {
    bridge: gateBridge({
      ...suppliers,
      gitAction: (request: unknown) => {
        requests.push(request);
        return script.gitAction ?? ACCEPTED_ACTION;
      },
    }),
    gitActionRequests: () => requests,
  };
}

/** A bridge whose answers a case can MOVE between calls, and the two movers for it. */
export interface MovingPort {
  readonly bridge: ConsoleBridge;
  readonly serveContext: (answer: unknown) => void;
  readonly serveGitAction: (answer: unknown) => void;
}

/**
 * A bridge whose replies a case can MOVE between calls.
 *
 * Two rules are about the SECOND answer differing from the first, which a fixed
 * script cannot express: a proposal is retained or discarded by comparing the context
 * a re-read served against the one it was prepared under, and an act's standing
 * refusal is cleared by pressing that act again against a different answer.
 */
export function bridgeWithMovingAnswers(prepare: unknown = SERVED_PREPARATION): MovingPort {
  let branchContext: unknown = SERVED_CONTEXT;
  let gitAction: unknown = WIRE_UNREGISTERED;
  return {
    bridge: gateBridge({
      branchContext: () => branchContext,
      prepare: () => prepare,
      gitAction: () => gitAction,
      callerParticipant: () => SERVED_CALLER_PARTICIPANT,
    }),
    serveContext: (answer: unknown) => {
      branchContext = answer;
    },
    serveGitAction: (answer: unknown) => {
      gitAction = answer;
    },
  };
}

/**
 * The readers one test file opened, and the one call that gives them all back.
 *
 * A CLASS RATHER THAN A MODULE-LEVEL ARRAY, which is the rule `apps/desktop/AGENTS.md`
 * states for state beside a module and matters twice as much here: two test files
 * import this module, and a shared array would make one file's teardown depend on
 * whether the other had run.
 */
export class OpenReaders {
  readonly #readers: ProposalGateReader[] = [];

  /** Construct a reader on the given port and remember it for teardown. */
  public open(
    bridge: ConsoleBridge,
    clock: ManualClock,
    subject: ProposalGateSubject = SUBJECT,
    // Defaulted, so a case that only cares about the READ says nothing about the
    // store. The trigger cases construct their own and drive it.
    sessionStore: SessionStore = new SessionStore({ sessionId: REPOS_SCENARIO.sessionId }),
  ): ProposalGateReader {
    const reader = new ProposalGateReader({ bridge, subject, sessionStore, clock });
    this.#readers.push(reader);
    return reader;
  }

  public disposeAll(): void {
    while (this.#readers.length > 0) {
      this.#readers.pop()?.dispose();
    }
  }
}

/** A store with a base state, which is what makes a later frame a frame and not history. */
export function initialisedStore(): SessionStore {
  const sessionStore = new SessionStore({ sessionId: REPOS_SCENARIO.sessionId });
  sessionStore.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
  return sessionStore;
}

/**
 * Drive the frozen clock past the debounce and let the read's promises settle.
 *
 * The second loop is not belt-and-braces. The arm is published from INSIDE the read,
 * so the first loop exits while the scheduler still holds `inFlight` — and a reason
 * requested in that window is deferred to the scheduler's own re-arm instead of
 * arming a timer. Draining past the read's completion is what makes the next
 * `advance` in a case observe the timer the case just asked for.
 */
export async function settle(clock: ManualClock, reader: ProposalGateReader): Promise<void> {
  clock.advance(REFRESH_DEBOUNCE_MS);
  for (let turn = 0; turn < 50 && reader.snapshot.state.kind === "preparing"; turn += 1) {
    await Promise.resolve();
  }
  for (let turn = 0; turn < 5; turn += 1) {
    await Promise.resolve();
  }
}

/** Let an act's promise chain and any re-read it queued run out. */
export async function settleAct(clock: ManualClock, reader: ProposalGateReader): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) {
    await Promise.resolve();
  }
  await settle(clock, reader);
}

/** The proposal the published arm carries, or `undefined` where it carries none. */
export function publishedProposalOf(reader: ProposalGateReader): unknown {
  const { state } = reader.snapshot;
  if (state.kind !== "prepared") {
    throw new Error(`a served context leaves the gate on \`prepared\`, not \`${state.kind}\``);
  }
  return state.proposal;
}
