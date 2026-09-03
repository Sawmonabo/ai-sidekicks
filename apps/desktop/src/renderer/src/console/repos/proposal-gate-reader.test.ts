// Each arm from its own outcome, each act from its own answer, and no timer at all.
//
// The served-context case drives the REAL fixture bridge against the repos scenario,
// which scripts `gitflow.branchContextRead`; the cases the fixture cannot reach —
// a served preparation, a served-but-unaccepted act, a reply that never arrived —
// drive a hand-built port, because the fixture's served set does not carry the
// preparation call and a test that skipped those arms would leave the reader's
// branching unchecked. Every clock is manual, so "the reader never polls" is read off
// `pendingCount` rather than asserted.

import { afterEach, describe, expect, it } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../bridge/index.js";
import { REPOS_SCENARIO } from "../bridge/scenarios/repos.js";
import {
  GIT_WORKSPACE_ID,
  IMPLEMENTER_WORKTREE_ID,
} from "../bridge/scenarios/repos-fixture-data.js";
import { ManualClock, REFRESH_DEBOUNCE_MS } from "../core/index.js";
import { SessionStore } from "../store/index.js";
import { ProposalGateReader, type ProposalGateReading } from "./proposal-gate-reader.js";
import { offeredProposalActions, type ProposalAction } from "./proposal-actions.js";
import type { ProposalContextKey } from "./prepared-proposal.js";
import {
  BRANCH_ROOT_UNADDRESSABLE_COPY,
  EPHEMERAL_CLONE_UNADDRESSABLE_COPY,
  type ProposalGateSubject,
} from "./proposal-gate-model.js";

const readers: ProposalGateReader[] = [];

afterEach(() => {
  while (readers.length > 0) {
    readers.pop()?.dispose();
  }
});

const SUBJECT: ProposalGateSubject = {
  kind: "worktree",
  workspaceId: GIT_WORKSPACE_ID,
  worktreeId: IMPLEMENTER_WORKTREE_ID,
  executionMode: "worktree",
};

/** A read-only subject on the mount whose mode produces no writable context. */
const READ_ONLY_SUBJECT: ProposalGateSubject = { ...SUBJECT, executionMode: "read-only" };

/** The port's refusal for a wire nothing has registered, as the live bridge returns it. */
const WIRE_UNREGISTERED = {
  status: "unavailable",
  code: "wire-unregistered",
  origin: "growth-port",
  detail: "Not checked — the branch-context read is not registered yet (Spec-011 owns it).",
} as const;

/** The port's other refusal class: the question was put and the answer never came. */
const REPLY_ABANDONED = {
  status: "unavailable",
  code: "reply-abandoned",
  origin: "growth-port",
  detail: "The scenario was torn down before the frozen clock reached this reply.",
} as const;

/** One served branch context, in the wire's own member names. */
const SERVED_CONTEXT = {
  status: "served",
  value: {
    branchContext: {
      branchContextId: "019b7b30-0280-7c11-8420-b1a5c0de2301",
      workspaceId: GIT_WORKSPACE_ID,
      baseBranch: "develop",
      headBranch: "feat/rate-limit-wiring",
      upstreamRef: "origin/feat/rate-limit-wiring",
      worktreeId: IMPLEMENTER_WORKTREE_ID,
    },
  },
} as const;

/** What each of the three growth operations answers, for one case. */
interface PortScript {
  readonly branchContext: unknown;
  readonly prepare?: unknown;
  readonly gitAction?: unknown;
}

/** A preparation the port serves, so a case can hold a proposal and then move the context. */
const SERVED_PREPARATION = {
  status: "served",
  value: {
    prPreparationId: "019b7b30-0280-7c11-8420-b1a5c0de2401",
    state: "ready",
    proposalBlob: { summary: "the rate limiter" },
  },
} as const;

/** One served context, with whichever of the pairing members a case wants moved. */
function servedContext(overrides: Partial<ProposalContextKey>): {
  status: "served";
  value: { branchContext: Record<string, unknown> };
} {
  return {
    status: "served",
    value: { branchContext: { ...SERVED_CONTEXT.value.branchContext, ...overrides } },
  };
}

/**
 * A bridge whose growth port answers exactly what a case scripts.
 *
 * The cast is `artifact-reader.test.ts`'s: the reader reaches three methods of one
 * namespace, and standing up the whole preload contract to reach them would be
 * scaffolding no assertion reads.
 */
function bridgeAnswering(script: PortScript): ConsoleBridge {
  return {
    growth: {
      gitflowBranchContextRead: async () => script.branchContext,
      gitflowPrPrepare: async () => script.prepare,
      gitActionExecute: async () => script.gitAction,
    },
  } as unknown as ConsoleBridge;
}

/** A bridge whose answers a case can MOVE between calls, and the two movers for it. */
interface MovingPort {
  readonly bridge: ConsoleBridge;
  readonly serveContext: (answer: unknown) => void;
  readonly serveGitAction: (answer: unknown) => void;
}

/**
 * A bridge whose replies a case can MOVE between calls.
 *
 * Two rules below are about the SECOND answer differing from the first, which a fixed
 * script cannot express: a proposal is retained or discarded by comparing the context
 * a re-read served against the one it was prepared under, and an act's standing
 * refusal is cleared by pressing that act again against a different answer.
 */
function bridgeWithMovingAnswers(prepare: unknown = SERVED_PREPARATION): MovingPort {
  let branchContext: unknown = SERVED_CONTEXT;
  let gitAction: unknown = WIRE_UNREGISTERED;
  return {
    bridge: {
      growth: {
        gitflowBranchContextRead: async () => branchContext,
        gitflowPrPrepare: async () => prepare,
        gitActionExecute: async () => gitAction,
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

function openReader(
  bridge: ConsoleBridge,
  clock: ManualClock,
  subject = SUBJECT,
  // Defaulted, so a case that only cares about the READ says nothing about the store.
  // The trigger cases below construct their own and drive it.
  sessionStore: SessionStore = new SessionStore({ sessionId: REPOS_SCENARIO.sessionId }),
): ProposalGateReader {
  const reader = new ProposalGateReader({ bridge, subject, sessionStore, clock });
  readers.push(reader);
  return reader;
}

/** A store with a base state, which is what makes a later frame a frame and not history. */
function initialisedStore(): SessionStore {
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
async function settle(clock: ManualClock, reader: ProposalGateReader): Promise<void> {
  clock.advance(REFRESH_DEBOUNCE_MS);
  for (let turn = 0; turn < 50 && reader.snapshot.state.kind === "preparing"; turn += 1) {
    await Promise.resolve();
  }
  for (let turn = 0; turn < 5; turn += 1) {
    await Promise.resolve();
  }
}

/** The proposal the published arm carries, or `undefined` where it carries none. */
function publishedProposalOf(reader: ProposalGateReader): unknown {
  const { state } = reader.snapshot;
  if (state.kind !== "prepared") {
    throw new Error(`a served context leaves the gate on \`prepared\`, not \`${state.kind}\``);
  }
  return state.proposal;
}

/** Let an act's promise chain and any re-read it queued run out. */
async function settleAct(clock: ManualClock, reader: ProposalGateReader): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) {
    await Promise.resolve();
  }
  await settle(clock, reader);
}

describe("ProposalGateReader — one arm per outcome", () => {
  it("says nobody could ask when the wire is unregistered, and carries the port's sentence", async () => {
    const clock = new ManualClock();
    const reader = openReader(bridgeAnswering({ branchContext: WIRE_UNREGISTERED }), clock);
    reader.start();
    await settle(clock, reader);

    const reading = reader.snapshot;
    expect(reading.state.kind).toBe("not-checked");
    // The arm carries no message of its own, so the refusal travels beside it — this
    // is the field the section renders through `RefusalCard`.
    expect(reading.refusal?.code).toBe("wire-unregistered");
    expect(reading.settlement).toBe(WIRE_UNREGISTERED.detail);
  });

  it("says the read failed when the question was put and the answer never came", async () => {
    // The OTHER refusal class, and it is a different arm: `not-checked` would claim
    // nothing was asked, which is false here.
    const clock = new ManualClock();
    const reader = openReader(bridgeAnswering({ branchContext: REPLY_ABANDONED }), clock);
    reader.start();
    await settle(clock, reader);

    const reading = reader.snapshot;
    expect(reading.state).toStrictEqual({ kind: "refused", message: REPLY_ABANDONED.detail });
    // The arm carries the message, so the same sentence is not also put beside it.
    expect(reading.refusal).toBeUndefined();
  });

  it("says the workspace has none, naming the mode, when the read served an absence", async () => {
    const clock = new ManualClock();
    const reader = openReader(
      bridgeAnswering({ branchContext: { status: "served", value: { branchContext: undefined } } }),
      clock,
      READ_ONLY_SUBJECT,
    );
    reader.start();
    await settle(clock, reader);

    expect(reader.snapshot.state).toStrictEqual({
      kind: "no-context",
      executionMode: "read-only",
    });
  });

  it("publishes the served context from the real fixture, verbatim and without the workspace id", async () => {
    const clock = new ManualClock();
    const reader = openReader(createFixtureBridge({ scenario: REPOS_SCENARIO }), clock);
    reader.start();
    await settle(clock, reader);

    const { state } = reader.snapshot;
    expect(state.kind).toBe("prepared");
    if (state.kind !== "prepared") {
      throw new Error("the fixture served a context, so the arm is `prepared`");
    }
    expect(state.context.baseBranch).toBe("develop");
    expect(state.context.headBranch).toBe("feat/rate-limit-wiring");
    expect(state.context.executionMode).toBe("worktree");
    // Nothing supplied a host, so none is claimed — the member is absent rather than
    // defaulted to a provider name.
    expect(state.detectedHost).toBeUndefined();
    expect(state.proposal).toBeUndefined();
    expect("workspaceId" in state.context).toBe(false);
  });

  it("negative control: nothing is read until the gate starts", async () => {
    // Without this the cases above would pass against a reader that read at
    // construction, which would put a call behind every render pass React discards.
    const clock = new ManualClock();
    const reader = openReader(bridgeAnswering({ branchContext: SERVED_CONTEXT }), clock);
    clock.advance(REFRESH_DEBOUNCE_MS);
    await Promise.resolve();

    expect(reader.performCount).toBe(0);
    expect(reader.snapshot.state.kind).toBe("not-checked");
    expect(reader.snapshot.refusal).toBeUndefined();
  });

  it("enters the wait once: a refresh redraws the answer, never the wait", async () => {
    const clock = new ManualClock();
    const reader = openReader(bridgeAnswering({ branchContext: SERVED_CONTEXT }), clock);
    const seen: ProposalGateReading[] = [];
    reader.subscribe((reading) => seen.push(reading));
    reader.start();
    await settle(clock, reader);

    window.dispatchEvent(new Event("focus"));
    await settle(clock, reader);

    expect(reader.performCount).toBe(2);
    expect(seen.filter((reading) => reading.state.kind === "preparing")).toHaveLength(1);
  });
});

describe("ProposalGateReader — the acts", () => {
  it("prepares against the context's own id and base branch, and folds the reply into the arm", async () => {
    const clock = new ManualClock();
    const reader = openReader(
      bridgeAnswering({
        branchContext: SERVED_CONTEXT,
        prepare: {
          status: "served",
          value: {
            prPreparationId: "019b7b30-0280-7c11-8420-b1a5c0de2401",
            state: "ready",
            proposalBlob: { summary: "the rate limiter" },
          },
        },
      }),
      clock,
    );
    reader.start();
    await settle(clock, reader);

    await reader.requestAction("prepare-proposal");
    await settleAct(clock, reader);

    const { state } = reader.snapshot;
    if (state.kind !== "prepared") {
      throw new Error("a served preparation leaves the gate on the `prepared` arm");
    }
    // The branches are the CONTEXT's, never the reply's — the reply carries none.
    expect(state.proposal).toStrictEqual({
      baseBranch: "develop",
      headBranch: "feat/rate-limit-wiring",
      state: "ready",
      blob: { summary: "the rate limiter" },
    });
    // The preparation re-read rather than publishing beside a stale context.
    expect(reader.performCount).toBe(2);
  });

  it("renders a refused act beside the control pressed and changes no arm", async () => {
    const clock = new ManualClock();
    const reader = openReader(
      bridgeAnswering({ branchContext: SERVED_CONTEXT, gitAction: WIRE_UNREGISTERED }),
      clock,
    );
    reader.start();
    await settle(clock, reader);
    const armBefore = reader.snapshot.state;

    await reader.requestAction("push");
    await settleAct(clock, reader);

    expect(reader.snapshot.actionRefusals.get("push")?.code).toBe("wire-unregistered");
    // The act did not happen, so the gate still reports what it last read.
    expect(reader.snapshot.state).toStrictEqual(armBefore);
    expect(reader.snapshot.actionRefusals.has("commit")).toBe(false);
  });

  it("records a served act the daemon did not accept rather than treating it as done", async () => {
    const clock = new ManualClock();
    const reader = openReader(
      bridgeAnswering({
        branchContext: SERVED_CONTEXT,
        gitAction: { status: "served", value: { accepted: false } },
      }),
      clock,
    );
    reader.start();
    await settle(clock, reader);

    await reader.requestAction("commit");
    await settleAct(clock, reader);

    expect(reader.snapshot.actionRefusals.get("commit")?.code).toBe("action-not-accepted");
    // Negative control for the case below: an unaccepted act does not re-read.
    expect(reader.performCount).toBe(1);
  });

  it("re-reads the context after an act the daemon accepted", async () => {
    const clock = new ManualClock();
    const reader = openReader(
      bridgeAnswering({
        branchContext: SERVED_CONTEXT,
        gitAction: { status: "served", value: { accepted: true } },
      }),
      clock,
    );
    reader.start();
    await settle(clock, reader);

    await reader.requestAction("commit");
    await settleAct(clock, reader);

    expect(reader.performCount).toBe(2);
    expect(reader.snapshot.actionRefusals.size).toBe(0);
  });
});

describe("ProposalGateReader — what a refused act leaves standing", () => {
  /** An accepted git action, which is what a successful retry answers with. */
  const ACCEPTED_ACTION = { status: "served", value: { accepted: true } } as const;

  /** Start a gate on the served context, with the acts answering `WIRE_UNREGISTERED`. */
  async function openOnServedContext(): Promise<{
    reader: ProposalGateReader;
    clock: ManualClock;
    port: MovingPort;
  }> {
    const clock = new ManualClock();
    const port = bridgeWithMovingAnswers();
    const reader = openReader(port.bridge, clock);
    reader.start();
    await settle(clock, reader);
    return { reader, clock, port };
  }

  it("clears the standing refusal when the same act is accepted", async () => {
    const { reader, clock, port } = await openOnServedContext();
    await reader.requestAction("push");
    await settleAct(clock, reader);
    expect(reader.snapshot.actionRefusals.get("push")?.code).toBe("wire-unregistered");

    port.serveGitAction(ACCEPTED_ACTION);
    await reader.requestAction("push");
    await settleAct(clock, reader);

    // Nothing is refusing this act any more, so nothing renders beside its control.
    expect(reader.snapshot.actionRefusals.has("push")).toBe(false);
  });

  it("renders the newer refusal when a retry is refused for a different reason", async () => {
    const { reader, clock, port } = await openOnServedContext();
    await reader.requestAction("push");
    await settleAct(clock, reader);

    port.serveGitAction(REPLY_ABANDONED);
    await reader.requestAction("push");
    await settleAct(clock, reader);

    expect(reader.snapshot.actionRefusals.get("push")?.code).toBe("reply-abandoned");
  });

  it("negative control: another act's refusal survives a successful one", async () => {
    // The clear is per-action on purpose. Without this case the two above would pass
    // against a reader that emptied the whole map on any press, which would erase a
    // failed commit the moment a push worked.
    const { reader, clock, port } = await openOnServedContext();
    await reader.requestAction("commit");
    await settleAct(clock, reader);
    expect(reader.snapshot.actionRefusals.get("commit")?.code).toBe("wire-unregistered");

    port.serveGitAction(ACCEPTED_ACTION);
    await reader.requestAction("push");
    await settleAct(clock, reader);

    expect(reader.snapshot.actionRefusals.get("commit")?.code).toBe("wire-unregistered");
    expect(reader.snapshot.actionRefusals.has("push")).toBe(false);
  });
});

describe("ProposalGateReader — the proposal and the context it was prepared for", () => {
  /** Prepare a proposal, then serve `nextContext` and let the re-read land. */
  async function prepareThenRefresh(nextContext: unknown): Promise<ProposalGateReader> {
    const clock = new ManualClock();
    const { bridge, serveContext } = bridgeWithMovingAnswers();
    const reader = openReader(bridge, clock);
    reader.start();
    await settle(clock, reader);

    await reader.requestAction("prepare-proposal");
    await settleAct(clock, reader);

    serveContext(nextContext);
    window.dispatchEvent(new Event("focus"));
    await settle(clock, reader);
    return reader;
  }

  it("keeps the proposal when the refreshed context is the same one", async () => {
    const reader = await prepareThenRefresh(SERVED_CONTEXT);

    expect(publishedProposalOf(reader)).toBeDefined();
    // The whole point of retaining it: the remote act stays offered.
    expect(offeredProposalActions(reader.snapshot.state)).toContain("push");
  });

  it("drops the proposal when the refreshed context is a different context row", async () => {
    const reader = await prepareThenRefresh(
      servedContext({ branchContextId: "019b7b30-0280-7c11-8420-b1a5c0de2399" }),
    );

    expect(publishedProposalOf(reader)).toBeUndefined();
    // Push is what a stale proposal would have authorised, so this is the claim.
    expect(offeredProposalActions(reader.snapshot.state)).not.toContain("push");
  });

  it("drops the proposal when the head branch moved under the same context row", async () => {
    // The id-only check would pass this one: a repair re-establishes the row over a
    // moved head, and the proposal was built against the branch that is gone.
    const reader = await prepareThenRefresh(servedContext({ headBranch: "feat/something-else" }));

    expect(publishedProposalOf(reader)).toBeUndefined();
    expect(offeredProposalActions(reader.snapshot.state)).not.toContain("push");
  });
});

describe("ProposalGateReader — what an accepted act leaves of the proposal", () => {
  /** An accepted git action, which is what the daemon answers a taken act with. */
  const ACCEPTED_ACTION = { status: "served", value: { accepted: true } } as const;

  /** Prepare a proposal, then send `action` against an accepting daemon. */
  async function prepareThenAct(action: ProposalAction): Promise<ProposalGateReader> {
    const clock = new ManualClock();
    const port = bridgeWithMovingAnswers();
    const reader = openReader(port.bridge, clock);
    reader.start();
    await settle(clock, reader);

    await reader.requestAction("prepare-proposal");
    await settleAct(clock, reader);
    if (publishedProposalOf(reader) === undefined) {
      throw new Error("the preparation has to land before the act that follows it");
    }

    port.serveGitAction(ACCEPTED_ACTION);
    await reader.requestAction(action);
    await settleAct(clock, reader);
    return reader;
  }

  it("discards the proposal an accepted commit made obsolete, and withdraws the send", async () => {
    // The context the re-read serves back is byte-identical — a commit moves neither
    // the context id nor either branch name — so the pairing check cannot see it and
    // the proposal has to be dropped by the act itself.
    const reader = await prepareThenAct("commit");

    expect(reader.snapshot.state.kind).toBe("prepared");
    expect(publishedProposalOf(reader)).toBeUndefined();
    // The claim: a payload that no longer describes the head cannot be sent.
    expect(offeredProposalActions(reader.snapshot.state)).not.toContain("push");
    expect(reader.snapshot.settlement).toBe(
      "A branch context was read. No proposal has been prepared yet.",
    );
  });

  it("negative control: an accepted push leaves the proposal it sent on screen", async () => {
    // Without this the case above would pass against a reader that dropped the
    // proposal on any accepted act, which would erase the summary of what was just
    // sent the moment it was sent.
    const reader = await prepareThenAct("push");

    expect(publishedProposalOf(reader)).toBeDefined();
    expect(offeredProposalActions(reader.snapshot.state)).toContain("push");
  });
});

describe("ProposalGateReader — one act at a time", () => {
  /** A port whose preparation the case releases by hand, so a press can be caught mid-call. */
  interface HeldPreparation {
    readonly bridge: ConsoleBridge;
    readonly prepareCallCount: () => number;
    readonly answer: () => void;
  }

  function bridgeHoldingPreparation(): HeldPreparation {
    let calls = 0;
    let release = (): void => {};
    const held = new Promise<void>((settle) => {
      release = (): void => {
        settle();
      };
    });
    return {
      bridge: {
        growth: {
          gitflowBranchContextRead: async () => SERVED_CONTEXT,
          gitflowPrPrepare: async () => {
            calls += 1;
            await held;
            return SERVED_PREPARATION;
          },
          gitActionExecute: async () => ({ status: "served", value: { accepted: true } }),
        },
      } as unknown as ConsoleBridge,
      prepareCallCount: () => calls,
      answer: release,
    };
  }

  /** A gate on the served context with one preparation held open on the wire. */
  async function openWithHeldPreparation(): Promise<{
    reader: ProposalGateReader;
    clock: ManualClock;
    port: HeldPreparation;
  }> {
    const clock = new ManualClock();
    const port = bridgeHoldingPreparation();
    const reader = openReader(port.bridge, clock);
    reader.start();
    await settle(clock, reader);
    void reader.requestAction("prepare-proposal");
    await Promise.resolve();
    return { reader, clock, port };
  }

  it("names the act it is waiting on while the bridge has not answered", async () => {
    const { reader } = await openWithHeldPreparation();
    expect(reader.snapshot.inFlightAction).toBe("prepare-proposal");
  });

  it("refuses a second act while one is unanswered, and issues no second call", async () => {
    // Two preparations can settle out of order and the older proposal then overwrites
    // the newer one; two commits confirmed against one payload are two commits.
    const { reader, clock, port } = await openWithHeldPreparation();

    await reader.requestAction("commit");

    expect(reader.snapshot.actionRefusals.get("commit")?.code).toBe("action-in-flight");
    // The refusal names the act actually being waited on, not the one pressed.
    expect(reader.snapshot.actionRefusals.get("commit")?.detail).toContain("Prepare proposal");
    expect(port.prepareCallCount()).toBe(1);

    port.answer();
    await settleAct(clock, reader);
    expect(reader.snapshot.inFlightAction).toBeUndefined();
  });

  it("negative control: the same act pressed after the first settles is admitted", async () => {
    // Without this the rule above would pass against a reader that refused every act
    // after the first one, which would make the gate single-use.
    const { reader, clock, port } = await openWithHeldPreparation();
    port.answer();
    await settleAct(clock, reader);

    await reader.requestAction("prepare-proposal");
    await settleAct(clock, reader);

    expect(reader.snapshot.actionRefusals.has("prepare-proposal")).toBe(false);
    expect(port.prepareCallCount()).toBe(2);
  });

  it("drops a settlement for a request the register has moved past", async () => {
    // A disposal moves the register out from under a call still on the wire. A
    // continuation that wrote anyway would publish onto a gate that has unmounted.
    const { reader, clock, port } = await openWithHeldPreparation();
    const readingBeforeDisposal = reader.snapshot;

    reader.dispose();
    port.answer();
    await settleAct(clock, reader);

    expect(reader.snapshot).toStrictEqual(readingBeforeDisposal);
  });
});

describe("ProposalGateReader — the reasons it reads again", () => {
  it("re-reads when the session's projection is repaired", async () => {
    // The reconnect refresh reason, which the gate had none of: a daemon that
    // reconnected while the window stayed focused left the branch context and the
    // prepared proposal standing, with `push` still offered against them.
    const clock = new ManualClock();
    const sessionStore = initialisedStore();
    const reader = openReader(
      bridgeAnswering({ branchContext: SERVED_CONTEXT }),
      clock,
      SUBJECT,
      sessionStore,
    );
    reader.start();
    await settle(clock, reader);
    expect(reader.performCount).toBe(1);

    sessionStore.markDegraded("subscription-closed");
    await settle(clock, reader);
    expect(reader.performCount).toBe(1);

    sessionStore.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
    await settle(clock, reader);

    expect(reader.performCount).toBe(2);
  });

  it("re-reads on a `workspace.stale` frame", async () => {
    // The terminal-event refresh reason. A path that went stale in an already-focused window used
    // to leave the gate reporting a context the daemon had stopped standing behind.
    const clock = new ManualClock();
    const sessionStore = initialisedStore();
    const reader = openReader(
      bridgeAnswering({ branchContext: SERVED_CONTEXT }),
      clock,
      SUBJECT,
      sessionStore,
    );
    reader.start();
    await settle(clock, reader);
    expect(reader.performCount).toBe(1);

    sessionStore.applyBatch([
      {
        // The canonical envelope names the row as well as its position, so a frame
        // the store admits carries one.
        id: "event-1",
        sessionId: REPOS_SCENARIO.sessionId,
        sequence: 1,
        kind: "workspace.stale",
        occurredAt: "2026-01-01T09:05:01.900Z",
      },
    ]);
    await settle(clock, reader);

    expect(reader.performCount).toBe(2);
  });

  it("negative control: a disposed gate re-reads on no later transition", async () => {
    // Without this the two cases above would pass against a reader whose triggers
    // outlived the component holding them, which is a read behind an unmounted gate.
    const clock = new ManualClock();
    const sessionStore = initialisedStore();
    const reader = openReader(
      bridgeAnswering({ branchContext: SERVED_CONTEXT }),
      clock,
      SUBJECT,
      sessionStore,
    );
    reader.start();
    await settle(clock, reader);
    const performedBeforeDispose = reader.performCount;

    reader.dispose();
    sessionStore.markDegraded("subscription-closed");
    sessionStore.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
    sessionStore.applyBatch([
      {
        id: "event-1",
        sessionId: REPOS_SCENARIO.sessionId,
        sequence: 1,
        kind: "workspace.stale",
        occurredAt: "2026-01-01T09:05:02.900Z",
      },
    ]);
    await settle(clock, reader);

    expect(reader.performCount).toBe(performedBeforeDispose);
  });
});

describe("ProposalGateReader — teardown", () => {
  it("arms no timer of its own and leaves none behind", async () => {
    const clock = new ManualClock();
    const reader = openReader(bridgeAnswering({ branchContext: SERVED_CONTEXT }), clock);
    reader.start();
    await settle(clock, reader);
    const performedBeforeDispose = reader.performCount;

    // A poll would fire here. The scheduler is the console's only timer and it re-arms
    // on a reason, so a long silence produces no read at all.
    clock.advance(REFRESH_DEBOUNCE_MS * 100);
    await Promise.resolve();
    expect(reader.performCount).toBe(performedBeforeDispose);

    reader.dispose();
    window.dispatchEvent(new Event("focus"));
    clock.advance(REFRESH_DEBOUNCE_MS * 10);
    await Promise.resolve();

    expect(reader.performCount).toBe(performedBeforeDispose);
    expect(clock.pendingCount).toBe(0);
  });
});

describe("ProposalGateReader — the roots the registered read has no key for", () => {
  /** A port that counts, so "no call was made" is read rather than inferred. */
  function countingPort(): { readonly bridge: ConsoleBridge; readonly calls: () => number } {
    let calls = 0;
    return {
      bridge: {
        growth: {
          gitflowBranchContextRead: async () => {
            calls += 1;
            return SERVED_CONTEXT;
          },
        },
      } as unknown as ConsoleBridge,
      calls: () => calls,
    };
  }

  const BRANCH_ROOT: ProposalGateSubject = {
    kind: "branch-root",
    workspaceId: GIT_WORKSPACE_ID,
    executionMode: "branch",
  };

  const CLONE_ROOT: ProposalGateSubject = {
    kind: "ephemeral-clone",
    workspaceId: GIT_WORKSPACE_ID,
    cloneId: "019b7b30-0280-7c11-8420-b1a5c0de2040",
    executionMode: "ephemeral clone",
  };

  it("says the question was not put, and names why, for an in-place root", async () => {
    const port = countingPort();
    const clock = new ManualClock();
    const reader = openReader(port.bridge, clock, BRANCH_ROOT);
    reader.start();
    await settle(clock, reader);

    const reading = reader.snapshot;
    // `not-checked` and never `no-context`: a workspace with no writable context is a
    // read that ANSWERED, and nothing here answered anything.
    expect(reading.state).toStrictEqual({ kind: "not-checked" });
    expect(reading.refusal?.code).toBe("subject-not-addressable");
    expect(reading.refusal?.detail).toBe(BRANCH_ROOT_UNADDRESSABLE_COPY);
    expect(reading.settlement).toBe(BRANCH_ROOT_UNADDRESSABLE_COPY);
  });

  it("says it for a clone root too, in that root's own words", async () => {
    const port = countingPort();
    const clock = new ManualClock();
    const reader = openReader(port.bridge, clock, CLONE_ROOT);
    reader.start();
    await settle(clock, reader);

    expect(reader.snapshot.refusal?.detail).toBe(EPHEMERAL_CLONE_UNADDRESSABLE_COPY);
  });

  it("makes no call and arms no read for a root it cannot ask about", async () => {
    // The rule the arm exists to enforce: sending the workspace id alone would be a
    // request shape no producer accepts, so nothing is sent — and nothing is armed
    // either, because a focus and a reconnect would each buy the same non-answer.
    const port = countingPort();
    const clock = new ManualClock();
    const store = initialisedStore();
    const reader = openReader(port.bridge, clock, BRANCH_ROOT, store);
    reader.start();
    await settle(clock, reader);
    // The two reasons a gate re-reads without anybody acting. Both reach an addressable
    // root; neither may buy a call here, because the answer would be the same refusal.
    store.markDegraded("subscription-closed");
    store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
    store.applyBatch([
      {
        id: "event-1",
        sessionId: REPOS_SCENARIO.sessionId,
        sequence: 1,
        kind: "workspace.stale",
        occurredAt: "2026-01-01T09:05:01.900Z",
      },
    ]);
    await settle(clock, reader);

    expect(port.calls()).toBe(0);
    expect(reader.performCount).toBe(0);
  });

  it("negative control: the one root the request HAS a key for is read as usual", async () => {
    // Without this, the three cases above would pass against a reader that had simply
    // stopped calling the wire for every subject.
    const port = countingPort();
    const clock = new ManualClock();
    const reader = openReader(port.bridge, clock, SUBJECT);
    reader.start();
    await settle(clock, reader);

    expect(port.calls()).toBe(1);
    expect(reader.performCount).toBe(1);
    expect(reader.snapshot.state.kind).toBe("prepared");
    expect(reader.snapshot.refusal).toBeUndefined();
  });
});
