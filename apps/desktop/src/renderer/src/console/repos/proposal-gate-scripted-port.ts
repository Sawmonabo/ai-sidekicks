// The scripted growth port every change-proposal gate case is driven against, the
// readers it opens, and the two drains that let a frozen clock settle.
//
// A SUPPORT MODULE RATHER THAN A COPY BESIDE EACH TEST, on
// `attachment-ingest-scripted-port.ts`'s precedent in this same family. The read half
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

import { growthUnavailable, type ConsoleBridge, type GrowthUnavailable } from "../bridge/index.js";
import { REPOS_SCENARIO } from "../bridge/scenarios/repos.js";
import {
  GIT_MOUNT_ID,
  GIT_WORKSPACE_ID,
  IMPLEMENTER_WORKTREE_ID,
  PARTICIPANT_YOU,
} from "../bridge/scenarios/repos-fixture-data.js";
import { ManualClock, REFRESH_DEBOUNCE_MS } from "../core/index.js";
import { SessionStore } from "../store/index.js";
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

/** The port's other refusal class: the question was put and the answer never came. */
export const REPLY_ABANDONED = {
  status: "unavailable",
  code: "reply-abandoned",
  origin: "growth-port",
  detail: "The scenario was torn down before the frozen clock reached this reply.",
} as const;

/**
 * One served branch context, in the wire's own member names.
 *
 * FLAT, exactly as `BranchContextReadResponse` returns it: the context's fields ARE
 * the reply, and there is no envelope member to reach through.
 *
 * ANNOTATED RATHER THAN `as const`, because two of its members are the scenario's own
 * exported ids: `isolatedDeclarations` cannot infer a const-asserted literal that
 * reaches through an import, so the shape is stated here and the ids stay the
 * fixture's rather than being respelled.
 */
export const SERVED_CONTEXT: {
  readonly status: "served";
  readonly value: Record<string, unknown>;
} = {
  status: "served",
  value: {
    branchContextId: "019b7b30-0280-7c11-8420-b1a5c0de2301",
    workspaceId: GIT_WORKSPACE_ID,
    baseBranch: "develop",
    headBranch: "feat/rate-limit-wiring",
    upstreamRef: "origin/feat/rate-limit-wiring",
    worktreeId: IMPLEMENTER_WORKTREE_ID,
  },
};

/** A preparation the port serves, so a case can hold a proposal and then move the context. */
export const SERVED_PREPARATION = {
  status: "served",
  value: {
    prPreparationId: "019b7b30-0280-7c11-8420-b1a5c0de2401",
    state: "ready",
    proposalBlob: { summary: "the rate limiter" },
  },
} as const;

/**
 * What the daemon answers an act it took with. Named once because three cases send one.
 *
 * `success`, which is `GitActionExecuteResponse`'s own member. The `accepted` this used
 * to carry was never on that reply at all.
 */
export const ACCEPTED_ACTION = { status: "served", value: { success: true } } as const;

/** The identity the caller read answers with, so an act carries the fixture's causation. */
export const SERVED_CALLER_PARTICIPANT: {
  readonly status: "served";
  readonly value: Record<string, unknown>;
} = { status: "served", value: { participantId: PARTICIPANT_YOU } };

/** One served context, with whichever of the pairing members a case wants moved. */
export function servedContext(overrides: Partial<ProposalContextKey>): {
  status: "served";
  value: Record<string, unknown>;
} {
  return {
    status: "served",
    value: { ...SERVED_CONTEXT.value, ...overrides },
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
async function scriptedAnswer(scripted: unknown): Promise<unknown> {
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
 * A bridge whose growth port answers exactly what a case scripts.
 *
 * The cast is `artifact-reader.test.ts`'s: the gate reaches three methods of one
 * namespace, and standing up the whole preload contract to reach them would be
 * scaffolding no assertion reads.
 */
export function bridgeAnswering(script: PortScript): ConsoleBridge {
  return {
    growth: {
      gitflowBranchContextRead: async () => scriptedAnswer(script.branchContext),
      gitflowPrPrepare: async () => scriptedAnswer(script.prepare),
      gitActionExecute: async () => scriptedAnswer(script.gitAction),
      callerParticipantRead: async () =>
        scriptedAnswer(script.callerParticipant ?? SERVED_CALLER_PARTICIPANT),
    },
  } as unknown as ConsoleBridge;
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
  return {
    bridge: {
      growth: {
        gitflowBranchContextRead: async () => script.branchContext,
        gitflowPrPrepare: async () => script.prepare,
        gitActionExecute: async (request: unknown) => {
          requests.push(request);
          return script.gitAction ?? ACCEPTED_ACTION;
        },
        callerParticipantRead: async () => script.callerParticipant ?? SERVED_CALLER_PARTICIPANT,
      },
    } as unknown as ConsoleBridge,
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
    bridge: {
      growth: {
        gitflowBranchContextRead: async () => branchContext,
        gitflowPrPrepare: async () => prepare,
        gitActionExecute: async () => gitAction,
        callerParticipantRead: async () => SERVED_CALLER_PARTICIPANT,
      },
    } as unknown as ConsoleBridge,
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
