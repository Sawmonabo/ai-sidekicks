// Which participant this window is: one injected read, held against its inputs.
//
// The failure this file exists for is a surface attributing what it renders to a
// participant nothing established. Three situations answer "nobody" if they are
// collapsed — the read is in flight, the read was refused, the read landed — and
// only the third is a fact about this window. So every case below asserts the ARM
// as well as the id, and the negative controls are the two guesses a convenient
// hook would make: taking the store's only participant as the caller, and treating
// a refusal as an absent identity.
//
// The third guess is holding an answer past the inputs that produced it. A pane
// that switches sessions or bridges is handed a new reader and a new store, and the
// replacement read settles a tick later; an answer carried across that interval is
// the previous window's participant reported as this session's. The input-change
// cases below are that interval, and they are why the settled identity carries the
// pair it was read against.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { refuse } from "../../core/index.js";
import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import {
  CALLER_IDENTITY_READ_FAILED,
  useCallerIdentity,
  type CallerParticipantReader,
} from "./caller-identity.js";
import { SessionStore } from "./session-store.js";

/** A store holding exactly the participants given, so two stores are two sessions. */
function storeWithParticipants(participantIds: readonly string[]): SessionStore {
  const store = new SessionStore({ sessionId: "session-1" });
  store.initialise({
    cursor: 0,
    entities: participantIds.map((participantId) => ({
      kind: "participant" as const,
      id: participantId,
      body: {},
    })),
    participantJoinLog: [...participantIds],
  });
  return store;
}

/** The rendered answer, flattened to one string so a case reads as one assertion. */
function Caller(props: {
  readonly read: CallerParticipantReader;
  readonly store: SessionStore;
}): React.JSX.Element {
  const result = useCallerIdentity(props.read, props.store);
  const detail =
    result.status === "read"
      ? result.participantId
      : result.status === "refused"
        ? result.refusal.code
        : "";
  return <span data-testid="caller">{`${result.status}|${detail}`}</span>;
}

/** The props a re-render supplies, when it supplies different ones. */
interface CallerInputs {
  readonly read: CallerParticipantReader;
  readonly store: SessionStore;
}

async function renderCaller(
  read: CallerParticipantReader,
  store: SessionStore,
): Promise<{
  readonly answer: () => string;
  readonly rerender: (next?: CallerInputs) => void;
}> {
  const view = render(<Caller read={read} store={store} />);
  await act(async () => undefined);
  return {
    answer: () => view.getByTestId("caller").textContent ?? "",
    rerender: (next) => {
      view.rerender(<Caller read={next?.read ?? read} store={next?.store ?? store} />);
    },
  };
}

/** A read the case settles by hand, so the in-flight interval is a place to assert. */
function deferredRead(): {
  readonly read: CallerParticipantReader;
  readonly settle: (participantId: string) => void;
} {
  let settle: (participantId: string) => void = () => undefined;
  const read: CallerParticipantReader = () =>
    new Promise((resolve) => {
      settle = resolve;
    });
  return { read, settle: (participantId) => settle(participantId) };
}

describe("useCallerIdentity — the injected caller read", () => {
  it("answers which participant this window is once the read lands", async () => {
    const store = storeWithParticipants(["participant-1", "participant-2"]);
    const { answer } = await renderCaller(() => Promise.resolve("participant-2"), store);
    expect(answer()).toBe("read|participant-2");
  });

  it("holds the not-loaded arm while the read is in flight", async () => {
    const store = storeWithParticipants(["participant-1"]);
    // A read that never settles: the arm before an answer is a real answer, and a
    // surface renders it as the "not loaded" kind of nothing rather than as an identity.
    const view = render(<Caller read={() => new Promise(() => undefined)} store={store} />);
    expect(view.getByTestId("caller").textContent).toBe("not-loaded|");
  });

  it("carries the refusal rather than an absent identity when the read is refused", async () => {
    const store = storeWithParticipants(["participant-1"]);
    const refusal = refuse("growth-port", "wire-unregistered", "Not checked on this build.");
    const { answer } = await renderCaller(() => Promise.resolve(refusal), store);
    expect(answer()).toBe("refused|wire-unregistered");
  });

  it("answers the id the read named even where the store holds no such participant", async () => {
    // The read is the sole authority on this question. Cross-checking it against the
    // store would make an id the session has not projected yet look like no identity
    // at all, which is a different fact from the one the reader stated.
    const store = storeWithParticipants(["participant-1"]);
    const { answer } = await renderCaller(() => Promise.resolve("participant-9"), store);
    expect(answer()).toBe("read|participant-9");
  });

  it("asks who the caller is once per input pair and keeps the answer across a re-render", async () => {
    const store = storeWithParticipants(["participant-1"]);
    let reads = 0;
    const read: CallerParticipantReader = () => {
      reads += 1;
      return Promise.resolve("participant-1");
    };
    const { answer, rerender } = await renderCaller(read, store);
    expect(answer()).toBe("read|participant-1");

    rerender();
    expect(reads).toBe(1);
    // And the answer survives that re-render. A hook that compared its stored
    // inputs by anything but identity — or re-stamped them on every pass — would
    // read as "not loaded" here on every frame, which is the opposite failure to
    // the one the input-change cases below are about.
    expect(answer()).toBe("read|participant-1");
  });

  it("negative control: never takes the store's only participant as the caller", async () => {
    // A hook that guessed would answer `participant-1` here, which is the whole
    // failure: one window's work attributed to somebody else. The read names
    // participant-9 and that is the only answer there is.
    const store = storeWithParticipants(["participant-1"]);
    const { answer } = await renderCaller(() => Promise.resolve("participant-9"), store);
    expect(answer()).not.toContain("participant-1");
  });

  it("negative control: a refusal is not reported as a read", async () => {
    // Without this, the refused case would pass over a hook that dropped the
    // refusal and answered the `read` arm — a surface would then attribute its work
    // to a participant nothing was ever able to name.
    const store = storeWithParticipants(["participant-1"]);
    const refusal = refuse("growth-port", "wire-unregistered", "Not checked on this build.");
    const { answer } = await renderCaller(() => Promise.resolve(refusal), store);
    expect(answer()).not.toContain("read|");
  });
});

/**
 * The two host methods that report a rejection nothing handled.
 *
 * Named here rather than by pulling `@types/node` into the renderer program, which
 * deliberately excludes it: a renderer MODULE reaching for `process` is a defect the
 * compiler should catch, and this file is the Node runner the suite executes on
 * looking at its own host. Nothing under `src/renderer/src/console/` other than this
 * witness reads it.
 */
const runnerHost = globalThis as unknown as {
  readonly process: {
    on: (event: "unhandledRejection", listener: (reason: unknown) => void) => void;
    off: (event: "unhandledRejection", listener: (reason: unknown) => void) => void;
  };
};

describe("useCallerIdentity — a reader that rejects rather than refusing", () => {
  /**
   * Every rejection the runner saw nothing handle while the body ran.
   *
   * The escaped-rejection half of this failure is invisible to `render`: React does
   * not route a rejected effect promise to an error boundary, so the only witness is
   * the host's own report. Listeners are added and removed around each body rather
   * than for the file, so a rejection another case raises cannot be counted here.
   */
  async function unhandledRejectionsDuring(body: () => Promise<void>): Promise<readonly string[]> {
    const escaped: string[] = [];
    const record = (reason: unknown): void => {
      escaped.push(String(reason));
    };
    runnerHost.process.on("unhandledRejection", record);
    try {
      await body();
      // An unhandled rejection is reported a macrotask after the microtask queue
      // drains, so a body that only awaited microtasks would report clean either way.
      await crossMacrotaskBoundary();
    } finally {
      runnerHost.process.off("unhandledRejection", record);
    }
    return escaped;
  }

  it("answers the refused arm with a stable code when the read rejects", async () => {
    const store = storeWithParticipants(["participant-1"]);
    const { answer } = await renderCaller(
      () => Promise.reject(new Error("the identity call never reached the daemon")),
      store,
    );
    expect(answer()).toBe(`refused|${CALLER_IDENTITY_READ_FAILED}`);
  });

  it("answers the refused arm when the reader throws before it returns a promise", async () => {
    // A synchronous throw is the same failure arriving one tick earlier, and the
    // `try` has to cover the CALL and not only the `await` for it to be caught.
    const store = storeWithParticipants(["participant-1"]);
    const { answer } = await renderCaller(() => {
      throw new Error("the reader was constructed against a bridge that is gone");
    }, store);
    expect(answer()).toBe(`refused|${CALLER_IDENTITY_READ_FAILED}`);
  });

  it("negative control: the rejection reaches no unhandled-rejection report", async () => {
    // The half `answer()` cannot see. On the old effect the rejection escaped the
    // detached async body, this listener recorded it, and the hook additionally sat
    // in `not-loaded` for the life of the pane.
    const store = storeWithParticipants(["participant-1"]);
    let rendered = "";
    const escaped = await unhandledRejectionsDuring(async () => {
      const { answer } = await renderCaller(
        () => Promise.reject(new Error("the identity call never reached the daemon")),
        store,
      );
      rendered = answer();
    });
    expect(escaped).toEqual([]);
    expect(rendered).not.toBe("not-loaded|");
  });

  it("sets nothing when the rejection lands after the inputs moved on", async () => {
    // The abandonment guard, on the failure arm. Settling the refusal here would
    // overwrite an answer the CURRENT inputs produced with one about inputs that are
    // gone — the same defect the settled arm's guard exists for.
    let rejectFirstRead: (reason: Error) => void = () => undefined;
    const firstRead: CallerParticipantReader = () =>
      new Promise((_resolve, reject) => {
        rejectFirstRead = reject;
      });
    const firstStore = storeWithParticipants(["participant-1"]);
    const secondStore = storeWithParticipants(["participant-2"]);
    const { answer, rerender } = await renderCaller(firstRead, firstStore);
    expect(answer()).toBe("not-loaded|");

    rerender({ read: () => Promise.resolve("participant-2"), store: secondStore });
    await act(async () => undefined);
    expect(answer()).toBe("read|participant-2");

    const escaped = await unhandledRejectionsDuring(async () => {
      await act(async () => {
        rejectFirstRead(new Error("the abandoned read failed long after it stopped mattering"));
      });
    });
    expect(answer()).toBe("read|participant-2");
    expect(escaped).toEqual([]);
  });
});

describe("useCallerIdentity — an answer belongs to the inputs that produced it", () => {
  it("reverts to not-loaded when the reader changes, until the replacement lands", async () => {
    // Both sessions hold `participant-1`, which is what makes the held-over answer
    // dangerous rather than merely stale: the old id is plausible in the new session,
    // so the hook would report an identity that session never established.
    const firstStore = storeWithParticipants(["participant-1"]);
    const secondStore = storeWithParticipants(["participant-1", "participant-2"]);
    const { answer, rerender } = await renderCaller(
      () => Promise.resolve("participant-1"),
      firstStore,
    );
    expect(answer()).toBe("read|participant-1");

    const replacement = deferredRead();
    rerender({ read: replacement.read, store: secondStore });
    expect(answer()).toBe("not-loaded|");

    await act(async () => {
      replacement.settle("participant-2");
    });
    expect(answer()).toBe("read|participant-2");
  });

  it("reverts to not-loaded when only the store changes", async () => {
    // The reader is unchanged and the store is not, which is the shape a second
    // session on one bridge takes. An identity is an answer about a participant IN a
    // session, so it is no more transferable across stores than across readers.
    const firstStore = storeWithParticipants(["participant-1"]);
    const secondStore = storeWithParticipants(["participant-1"]);
    const read: CallerParticipantReader = () => Promise.resolve("participant-1");
    const { answer, rerender } = await renderCaller(read, firstStore);
    expect(answer()).toBe("read|participant-1");

    // The re-render flushes effects but not the microtask the read settles on, so
    // this is exactly the interval the old hook rendered the previous answer in.
    rerender({ read, store: secondStore });
    expect(answer()).toBe("not-loaded|");

    await act(async () => undefined);
    expect(answer()).toBe("read|participant-1");
  });

  it("discards a first read that lands after the inputs moved on", async () => {
    // The abandonment guard, pinned: a settlement that arrives after the switch
    // must not overwrite the answer the current inputs produced, and must not
    // re-enter the loading arm either.
    const first = deferredRead();
    const firstStore = storeWithParticipants(["participant-1"]);
    const secondStore = storeWithParticipants(["participant-1", "participant-2"]);
    const { answer, rerender } = await renderCaller(first.read, firstStore);
    expect(answer()).toBe("not-loaded|");

    rerender({ read: () => Promise.resolve("participant-2"), store: secondStore });
    await act(async () => undefined);
    expect(answer()).toBe("read|participant-2");

    await act(async () => {
      first.settle("participant-1");
    });
    expect(answer()).toBe("read|participant-2");
  });
});
