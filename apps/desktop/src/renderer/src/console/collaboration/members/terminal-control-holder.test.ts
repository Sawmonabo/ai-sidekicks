// The lease holding: three values, the reason it is not two, and what moves it.
//
// The dangerous collapse is `null` and "not read yet" arriving at a row as one thing.
// `null` is the wire saying nobody holds the shared terminal, which is a state a
// person may act on; an unanswered read says nothing at all. A reader that returned
// "unheld" for both would invite somebody to take a shell another participant is
// holding, on the strength of the console's own failure to read.
//
// AND THE SECOND HALF IS WHEN THE ANSWER MOVES. The lease is claimed and released from
// the terminal pane, which this section cannot see, so a holder read once at mount is
// a holder this surface keeps naming after the shell has changed hands. Those cases
// drive the real model over a real store: the answer is scripted to change, and what
// is asserted is that the registered transition — and nothing else — makes the roster
// ask again.

import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import { act } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  fixtureBridgeWithGrowth,
  growthAnswering,
  growthRefusing,
  unscriptedScenario,
} from "../../bridge/fixture/fixture-bridge.test-support.js";
import type { ConsoleBridge } from "../../bridge/index.js";
import { ManualClock, REFRESH_MAX_WAIT_MS } from "../../core/index.js";
import { eventOfKind } from "../../store/session-event.test-support.js";
import { initialisedStore } from "../../store/session-store-registry.test-support.js";
import type { SessionStore } from "../../store/index.js";
import {
  createTerminalControlHolder,
  terminalControlHolderRefusal,
  terminalControlHolding,
  type TerminalControlHolderRead,
  type TerminalControlHolderState,
  type TerminalControlHolderValue,
} from "./terminal-control-holder.js";

const HELD: TerminalControlHolderState = {
  kind: "loaded",
  value: { controlHolder: "participant-tomas" },
};

const FREE: TerminalControlHolderState = { kind: "loaded", value: { controlHolder: null } };

const UNREAD: TerminalControlHolderState = { kind: "not-loaded" };

const FAILED: TerminalControlHolderState = {
  kind: "failed",
  refusal: {
    origin: "terminal-control-holder",
    code: "bridge.unreachable",
    detail: "The bridge went away.",
  },
};

describe("terminal control — what the read said", () => {
  it("names the holder where the wire named one", () => {
    expect(terminalControlHolding(HELD)).toStrictEqual({
      kind: "held",
      participantId: "participant-tomas",
    });
  });

  it("reads a null holder as a free lease, which is an answer", () => {
    // The registered member resolves to null both when nobody holds the lease and
    // when the holding node reads offline. Both are "no advertised holder", which is
    // what the surface draws.
    expect(terminalControlHolding(FREE)).toStrictEqual({ kind: "unheld" });
  });

  it("reads every arm that is not a loaded answer as unread rather than as a free lease", () => {
    expect(terminalControlHolding(UNREAD)).toStrictEqual({ kind: "unread" });
    expect(terminalControlHolding(FAILED)).toStrictEqual({ kind: "unread" });
  });
});

describe("terminal control — why the holder is not here", () => {
  it("carries the refusal off the failed arm", () => {
    expect(terminalControlHolderRefusal(FAILED)?.code).toBe("bridge.unreachable");
  });

  it("negative control: a served read and a read in flight carry none", () => {
    expect(terminalControlHolderRefusal(HELD)).toBeUndefined();
    expect(terminalControlHolderRefusal(FREE)).toBeUndefined();
    expect(terminalControlHolderRefusal(UNREAD)).toBeUndefined();
  });
});

/**
 * The lease as a session whose holder changes between reads.
 *
 * A class rather than a captured `let`, per this package's state rule. Each read takes
 * the next scripted answer and the last one stands for every read after it, so a case
 * that reads more often than it scripts sees a settled lease rather than an error.
 */
class ScriptedLeaseAnswers {
  readonly #answers: readonly (string | null)[];
  #readCount = 0;

  public constructor(answers: readonly (string | null)[]) {
    this.#answers = answers;
  }

  /** The holder this read answers with. */
  public next(): string | null {
    const answer = this.#answers[Math.min(this.#readCount, this.#answers.length - 1)] ?? null;
    this.#readCount += 1;
    return answer;
  }
}

function bridgeAnswering(answers: ScriptedLeaseAnswers): ConsoleBridge {
  return fixtureBridgeWithGrowth(unscriptedScenario("terminal-control-holder"), {
    terminalControlHolderRead: growthAnswering<TerminalControlHolderValue>(async () =>
      Promise.resolve({ controlHolder: answers.next() }),
    ),
  });
}

/** A started holder read over a store this case owns, on frozen time. */
function startedHolder(
  sessionStore: SessionStore,
  clock: ManualClock,
  answers: ScriptedLeaseAnswers,
): TerminalControlHolderRead {
  const read = createTerminalControlHolder({
    bridge: bridgeAnswering(answers),
    sessionStore,
    clock,
  });
  read.start();
  return read;
}

/** Let every refresh armed inside the coalescing window fall due. */
async function settleReads(clock: ManualClock): Promise<void> {
  await act(async () => {
    clock.advance(REFRESH_MAX_WAIT_MS);
    for (let pass = 0; pass < 4; pass += 1) {
      await crossMacrotaskBoundary();
    }
  });
}

/** One `pty.control_changed` at the given position. The payload is never opened. */
function leaseTransition(sessionStore: SessionStore, sequence: number): void {
  sessionStore.apply(eventOfKind(sessionStore.sessionId, "pty.control_changed", sequence));
}

describe("terminal control — what re-reads the holder", () => {
  it("re-reads when the lease transition arrives, and names the new holder", async () => {
    const sessionStore = initialisedStore("session-lease-moved");
    const clock = new ManualClock();
    const read = startedHolder(
      sessionStore,
      clock,
      new ScriptedLeaseAnswers(["participant-tomas", null]),
    );
    await settleReads(clock);

    expect(terminalControlHolding(read.state)).toStrictEqual({
      kind: "held",
      participantId: "participant-tomas",
    });

    // A release, an auto-release on disconnect, and an auto-release on lost
    // authorization all reach the stream as this one kind — so the roster answering
    // it with a fresh read is what covers every one of them.
    leaseTransition(sessionStore, 1);
    await settleReads(clock);

    expect(read.readCount).toBe(2);
    expect(terminalControlHolding(read.state)).toStrictEqual({ kind: "unheld" });
    read.dispose();
  });

  it("coalesces a burst of transitions into one read", async () => {
    const sessionStore = initialisedStore("session-lease-burst");
    const clock = new ManualClock();
    const read = startedHolder(sessionStore, clock, new ScriptedLeaseAnswers(["participant-you"]));
    await settleReads(clock);

    leaseTransition(sessionStore, 1);
    leaseTransition(sessionStore, 2);
    leaseTransition(sessionStore, 3);
    await settleReads(clock);

    expect(read.readCount).toBe(2);
    read.dispose();
  });

  it("negative control: re-reads nothing for a kind the lease does not watch", async () => {
    // Without this the cases above would hold over a read that re-asked on every
    // store transition — which is a poll wearing an event's clothes, and would put a
    // wire call behind every token of a busy run.
    const sessionStore = initialisedStore("session-lease-unwatched");
    const clock = new ManualClock();
    const read = startedHolder(
      sessionStore,
      clock,
      new ScriptedLeaseAnswers(["participant-tomas", null]),
    );
    await settleReads(clock);

    sessionStore.apply(eventOfKind(sessionStore.sessionId, "assistant.message", 1));
    await settleReads(clock);

    expect(read.readCount).toBe(1);
    expect(terminalControlHolding(read.state)).toStrictEqual({
      kind: "held",
      participantId: "participant-tomas",
    });
    read.dispose();
  });

  it("re-reads nothing once the models that own it are disposed", async () => {
    const sessionStore = initialisedStore("session-lease-disposed");
    const clock = new ManualClock();
    const read = startedHolder(sessionStore, clock, new ScriptedLeaseAnswers(["participant-you"]));
    await settleReads(clock);

    read.dispose();
    leaseTransition(sessionStore, 1);
    await settleReads(clock);

    expect(read.readCount).toBe(1);
    expect(clock.pendingCount).toBe(0);
  });

  it("renders the port's own refusal rather than a free lease", async () => {
    // The live bridge answers this operation with a typed refusal, which is the
    // ordinary path until the wire lands — and the holding it produces is `unread`,
    // never the unheld lease that would invite somebody to claim the shell.
    const sessionStore = initialisedStore("session-lease-refused");
    const clock = new ManualClock();
    const read = createTerminalControlHolder({
      bridge: fixtureBridgeWithGrowth(unscriptedScenario("terminal-control-holder-refused"), {
        terminalControlHolderRead: growthRefusing("terminalControlHolderRead"),
      }),
      sessionStore,
      clock,
    });
    read.start();
    await settleReads(clock);

    expect(terminalControlHolding(read.state)).toStrictEqual({ kind: "unread" });
    expect(terminalControlHolderRefusal(read.state)?.code).toBe("wire-unregistered");
    read.dispose();
  });
});
