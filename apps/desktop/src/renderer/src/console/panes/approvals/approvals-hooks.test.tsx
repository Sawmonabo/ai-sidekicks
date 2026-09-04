// The fourth reason this surface re-reads, and the session the reader is bound to.
//
// Driven through the real hook against a real `SessionStore`, because both claims are
// about that store — the sticky degraded flag's transition and the identity a rebound
// pane hands the hook — and a stub of it would be a stand-in for the very thing under
// test. The reader is observed through the handle the hook returns, so what is
// asserted is the reason it was asked for rather than a call some spy stood in for.
//
// The frozen clock is advanced only where a test needs the read PERFORMED, which is
// the rebinding block below: everything else is about which reasons reach the
// scheduler, and the scheduler's own coalescing has its own tests.

import { act, render } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";

import { ManualClock, REFRESH_MAX_WAIT_MS } from "../../core/index.js";
import { type ConsoleBridge } from "../../bridge/index.js";
import { SessionStore, type ConsoleSessionEvent } from "../../store/index.js";
import { useApprovalsReader, useSessionGoalMutation } from "./approvals-hooks.js";
import { type ApprovalsReader } from "./approvals-reader.js";
import { APPROVAL_PROJECTION_READ_METHOD } from "./approvals-wire.js";

const SESSION_ID = "019b7a33-3300-75e5-8510-ada11a5a55a5";
const SECOND_SESSION_ID = "019b7a33-3300-75e5-8510-ada11a5a55b6";

/** One recorded wire call, so a read can be attributed to the session it named. */
interface RecordedCall {
  readonly method: string;
  readonly params: unknown;
}

interface ObservableBridge {
  readonly bridge: ConsoleBridge;
  readonly clock: ManualClock;
  readonly calls: readonly RecordedCall[];
}

/** A bridge that answers empty and remembers what it was asked. */
function observableBridge(): ObservableBridge {
  const clock = new ManualClock();
  const calls: RecordedCall[] = [];
  const bridge = {
    sidekicks: {
      daemon: {
        call: async (method: string, params: unknown): Promise<unknown> => {
          calls.push({ method, params });
          return { requests: [], rules: [] };
        },
        subscribe: () => () => undefined,
      },
    },
    growth: {},
    source: "fixture",
    scenarioEngine: { clock },
  } as unknown as ConsoleBridge;
  return { bridge, clock, calls };
}

/** A bridge that answers nothing: no read is performed by the callers of this one. */
function silentBridge(): ConsoleBridge {
  return observableBridge().bridge;
}

function ReaderHarness(props: {
  readonly bridge: ConsoleBridge;
  readonly sessionStore: SessionStore;
  readonly onReader: (reader: ApprovalsReader) => void;
}): React.JSX.Element | null {
  const { reader } = useApprovalsReader(props.bridge, props.sessionStore);
  const { onReader } = props;
  useEffect(() => {
    onReader(reader);
  }, [onReader, reader]);
  return null;
}

async function mountReader(sessionStore: SessionStore): Promise<ApprovalsReader> {
  let held: ApprovalsReader | undefined;
  await act(async () => {
    render(
      <ReaderHarness
        bridge={silentBridge()}
        sessionStore={sessionStore}
        onReader={(reader) => {
          held = reader;
        }}
      />,
    );
  });
  if (held === undefined) {
    throw new Error("the hook handed back no reader");
  }
  return held;
}

function initialisedStore(sessionId = SESSION_ID): SessionStore {
  const store = new SessionStore({ sessionId });
  store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
  return store;
}

/**
 * One lifecycle signal, at the local position a relayed event would take.
 *
 * The row id is composed from the position rather than fixed, because it is the
 * event's own identifier and two rows of one session never share one.
 */
function lifecycleEvent(sessionId: string, sequence: number): ConsoleSessionEvent {
  return {
    id: `event-${String(sequence)}`,
    sessionId,
    sequence,
    kind: "approval.requested",
    occurredAt: "2026-01-01T00:00:00.000Z",
  };
}

function sessionIdsRead(calls: readonly RecordedCall[]): readonly unknown[] {
  return calls
    .filter((call) => call.method === APPROVAL_PROJECTION_READ_METHOD)
    .map((call) => (call.params as { readonly sessionId?: unknown }).sessionId);
}

describe("the read that follows a reconnect", () => {
  it("asks for one read when a degraded session store is repaired", async () => {
    const sessionStore = initialisedStore();
    const reader = await mountReader(sessionStore);
    // Spied after mount, so the `subscribe` read this surface already takes is not
    // in the count and the reason asserted below is the one this test caused.
    const requestRead = vi.spyOn(reader, "requestRead");

    act(() => {
      sessionStore.markDegraded("subscription-closed");
    });
    // Losing the stream is not the moment: the pane cannot read its way out of a
    // session that is still down, and a read fired here would be one the scheduler
    // performs against a wire that is not answering.
    expect(requestRead).not.toHaveBeenCalled();

    act(() => {
      sessionStore.initialise({ cursor: 4, entities: [], participantJoinLog: [] });
    });
    expect(requestRead).toHaveBeenCalledTimes(1);
    expect(requestRead).toHaveBeenCalledWith("reconnect");
  });

  it("negative control: a store that never degraded asks for no reconnect read", async () => {
    // Without this the case above would pass over a hook that re-read on every
    // transition of the store, which is an interval in everything but name.
    const sessionStore = initialisedStore();
    const reader = await mountReader(sessionStore);
    const requestRead = vi.spyOn(reader, "requestRead");

    act(() => {
      sessionStore.initialise({ cursor: 4, entities: [], participantJoinLog: [] });
    });
    expect(requestRead).not.toHaveBeenCalled();
  });

  it("asks again when the stream is lost and repaired a second time", async () => {
    const sessionStore = initialisedStore();
    const reader = await mountReader(sessionStore);
    const requestRead = vi.spyOn(reader, "requestRead");

    for (const cursor of [4, 8]) {
      act(() => {
        sessionStore.markDegraded("sequence-gap");
      });
      act(() => {
        sessionStore.initialise({ cursor, entities: [], participantJoinLog: [] });
      });
    }
    expect(requestRead).toHaveBeenCalledTimes(2);
  });
});

// A reader is bound to the session it reads. The pane is rebound — the deck keeps the
// mounted pane and hands it a different session — and every case below is one the
// `useState` initializer got wrong, because that initializer never runs a second time.
describe("the reader is bound to the session it reads", () => {
  /** Mount the harness, then rebind it to a second store. Returns both readers. */
  async function mountThenRebind(options: {
    readonly bridge: ConsoleBridge;
    readonly first: SessionStore;
    readonly second: SessionStore;
    readonly beforeRebind?: () => void;
  }): Promise<{ readonly first: ApprovalsReader; readonly second: ApprovalsReader }> {
    const seen: ApprovalsReader[] = [];
    const onReader = (reader: ApprovalsReader): void => {
      seen.push(reader);
    };
    let rerender: (element: React.JSX.Element) => void = () => undefined;
    await act(async () => {
      const result = render(
        <ReaderHarness bridge={options.bridge} sessionStore={options.first} onReader={onReader} />,
      );
      rerender = result.rerender;
    });
    options.beforeRebind?.();
    await act(async () => {
      rerender(
        <ReaderHarness bridge={options.bridge} sessionStore={options.second} onReader={onReader} />,
      );
    });
    const [first, second] = seen;
    if (first === undefined || second === undefined) {
      throw new Error("the hook did not hand back two readers");
    }
    return { first, second };
  }

  it("builds a second reader for the second session and reads THAT session", async () => {
    // The negative control is the old initializer itself: it handed back the same
    // reader object across the rebind, and every read it performed named the first
    // session — which is the whole finding.
    const { bridge, clock, calls } = observableBridge();
    const readers = await mountThenRebind({
      bridge,
      first: initialisedStore(),
      second: initialisedStore(SECOND_SESSION_ID),
    });
    expect(readers.second).not.toBe(readers.first);

    await act(async () => {
      clock.advance(REFRESH_MAX_WAIT_MS);
    });
    expect(sessionIdsRead(calls)).toContain(SECOND_SESSION_ID);
  });

  it("disposes the reader it replaced, and on unmount exactly the live one", async () => {
    const { bridge } = observableBridge();
    const first = initialisedStore();
    const second = initialisedStore(SECOND_SESSION_ID);
    const seen: ApprovalsReader[] = [];
    const onReader = (reader: ApprovalsReader): void => {
      seen.push(reader);
    };
    let rerender: (element: React.JSX.Element) => void = () => undefined;
    let unmount: () => void = () => undefined;
    await act(async () => {
      const result = render(
        <ReaderHarness bridge={bridge} sessionStore={first} onReader={onReader} />,
      );
      rerender = result.rerender;
      unmount = result.unmount;
    });
    const firstReader = seen[0];
    if (firstReader === undefined) {
      throw new Error("the hook handed back no reader");
    }
    const disposeFirst = vi.spyOn(firstReader, "dispose");

    await act(async () => {
      rerender(<ReaderHarness bridge={bridge} sessionStore={second} onReader={onReader} />);
    });
    const secondReader = seen.at(-1);
    if (secondReader === undefined || secondReader === firstReader) {
      throw new Error("the rebind did not build a second reader");
    }
    const disposeSecond = vi.spyOn(secondReader, "dispose");
    // The rebind disposes the reader it replaced and NOT the one it just built.
    expect(disposeFirst).toHaveBeenCalledTimes(1);
    expect(disposeSecond).not.toHaveBeenCalled();

    await act(async () => {
      unmount();
    });
    expect(disposeSecond).toHaveBeenCalledTimes(1);
    expect(disposeFirst).toHaveBeenCalledTimes(1);
  });

  it("does not carry the previous session's lifecycle high-water mark", async () => {
    // The retained cursor's mark sat at the first session's newest signal, so the
    // second session's own signal — at a lower local position, which is ordinary
    // for a fresh session — was read as already covered and never re-read.
    const { bridge } = observableBridge();
    const first = initialisedStore();
    first.apply(lifecycleEvent(SESSION_ID, 90));
    const second = initialisedStore(SECOND_SESSION_ID);
    const readers = await mountThenRebind({ bridge, first, second });
    const requestRead = vi.spyOn(readers.second, "requestRead");

    act(() => {
      second.apply(lifecycleEvent(SECOND_SESSION_ID, 3));
    });
    expect(requestRead).toHaveBeenCalledWith("terminal-event");
  });

  it("does not read a session left degraded as a repair of the next one", async () => {
    // The retained watcher remembered the first session's standing degraded flag, so
    // the second session's very first pass — which is not degraded — looked like the
    // repair transition and fired a reconnect read nothing had repaired.
    const { bridge } = observableBridge();
    const first = initialisedStore();
    const second = initialisedStore(SECOND_SESSION_ID);
    const readers = await mountThenRebind({
      bridge,
      first,
      second,
      beforeRebind: () => {
        act(() => {
          first.markDegraded("subscription-closed");
        });
      },
    });
    const requestRead = vi.spyOn(readers.second, "requestRead");

    act(() => {
      second.initialise({ cursor: 4, entities: [], participantJoinLog: [] });
    });
    expect(requestRead).not.toHaveBeenCalledWith("reconnect");
  });
});

// The goal mutation's subject. `session.goalUpdate` names the session it mutates, so
// everything this hook holds — the in-flight latch and the two readings — belongs to
// the `(bridge, sessionId)` the call was issued under, and the component outlives a
// change of that pair.
describe("the goal mutation is keyed to the session it mutates", () => {
  /** A bridge whose goal call is settled by the test rather than by a timer. */
  function deferredGoalBridge(): {
    readonly bridge: ConsoleBridge;
    readonly rejectFor: (sessionId: string, rejection: unknown) => void;
    readonly sessionIdsCalled: readonly string[];
  } {
    const rejectBySessionId = new Map<string, (rejection: unknown) => void>();
    const sessionIdsCalled: string[] = [];
    const bridge = {
      sidekicks: {
        daemon: {
          call: async (_method: string, params: unknown): Promise<unknown> => {
            const { sessionId } = params as { readonly sessionId: string };
            sessionIdsCalled.push(sessionId);
            return new Promise<unknown>((_resolve, reject) => {
              rejectBySessionId.set(sessionId, reject);
            });
          },
          subscribe: () => () => undefined,
        },
      },
      growth: {},
      source: "fixture",
      scenarioEngine: undefined,
    } as unknown as ConsoleBridge;
    return {
      bridge,
      rejectFor: (sessionId, rejection) => {
        const reject = rejectBySessionId.get(sessionId);
        if (reject === undefined) {
          throw new Error(`no goal call is outstanding for ${sessionId}`);
        }
        reject(rejection);
      },
      sessionIdsCalled,
    };
  }

  type GoalMutation = ReturnType<typeof useSessionGoalMutation>;

  function GoalHarness(props: {
    readonly bridge: ConsoleBridge;
    readonly sessionId: string;
    readonly onMutation: (mutation: GoalMutation) => void;
  }): React.JSX.Element | null {
    const mutation = useSessionGoalMutation(props.bridge, props.sessionId);
    props.onMutation(mutation);
    return null;
  }

  /** Mount against one session, then rebind the mounted card to another. */
  function mountGoalCard(bridge: ConsoleBridge): {
    readonly latest: () => GoalMutation;
    readonly rebindTo: (sessionId: string) => void;
  } {
    let latest: GoalMutation | undefined;
    const onMutation = (mutation: GoalMutation): void => {
      latest = mutation;
    };
    const view = render(
      <GoalHarness bridge={bridge} sessionId={SESSION_ID} onMutation={onMutation} />,
    );
    return {
      latest: () => {
        if (latest === undefined) {
          throw new Error("the hook handed back no mutation");
        }
        return latest;
      },
      rebindTo: (sessionId) => {
        act(() => {
          view.rerender(
            <GoalHarness bridge={bridge} sessionId={sessionId} onMutation={onMutation} />,
          );
        });
      },
    };
  }

  it("frees the new session's controls while the old session's change is settling", () => {
    const { bridge, sessionIdsCalled } = deferredGoalBridge();
    const card = mountGoalCard(bridge);
    act(() => {
      card.latest().update("the first session's goal");
    });
    expect(card.latest().isMutating).toBe(true);

    card.rebindTo(SECOND_SESSION_ID);
    // The first session's call is still outstanding and this session has none, so
    // this session's controls are its own.
    expect(card.latest().isMutating).toBe(false);
    expect(card.latest().refusal).toBeUndefined();

    act(() => {
      card.latest().update("the second session's goal");
    });
    expect(sessionIdsCalled).toStrictEqual([SESSION_ID, SECOND_SESSION_ID]);
    expect(card.latest().refusal).toBeUndefined();
  });

  it("installs nothing from a rejection that answers a session the card left", async () => {
    const { bridge, rejectFor } = deferredGoalBridge();
    const card = mountGoalCard(bridge);
    act(() => {
      card.latest().update("the first session's goal");
    });
    card.rebindTo(SECOND_SESSION_ID);

    await act(async () => {
      rejectFor(SESSION_ID, new Error("the first session refused"));
      await Promise.resolve();
    });
    // The rejection belongs to a session this card is no longer addressed to, so
    // rendering it here would put one session's refusal beside another's goal.
    expect(card.latest().refusal).toBeUndefined();
    expect(card.latest().isMutating).toBe(false);
  });

  it("keeps the pending reading across a re-render that changes no subject", () => {
    const { bridge } = deferredGoalBridge();
    const card = mountGoalCard(bridge);
    act(() => {
      card.latest().update("the first session's goal");
    });
    card.rebindTo(SESSION_ID);
    expect(card.latest().isMutating).toBe(true);
  });

  it("negative control: a second change to the SAME session is still refused", () => {
    // Without this, a latch that had simply stopped guarding anything would pass
    // every case above while sending two mutations for one session.
    const { bridge, sessionIdsCalled } = deferredGoalBridge();
    const card = mountGoalCard(bridge);
    act(() => {
      card.latest().update("the first goal");
    });
    act(() => {
      card.latest().update("a second goal, sent before the first landed");
    });
    expect(sessionIdsCalled).toStrictEqual([SESSION_ID]);
    expect(card.latest().refusal?.code).toBe("goal_mutation_in_flight");
  });
});
