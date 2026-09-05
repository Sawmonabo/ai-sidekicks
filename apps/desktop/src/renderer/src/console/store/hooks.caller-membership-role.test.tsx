// The caller's own role: one injected read, chained to the roster lookup.
//
// The failure this file exists for is a surface offering a control on a role
// nothing established. Three situations answer "not an owner" if they are
// collapsed — the read is in flight, the read was refused, the roster holds no
// entry — and only the third is anything like a fact about the participant. So
// every case below asserts the ARM as well as the role, and the negative controls
// are the two guesses a convenient hook would make: taking the roster's only
// entry as the caller, and treating a refusal as an absent role.
//
// The fourth guess is holding an answer past the inputs that produced it. A pane
// that switches sessions or bridges is handed a new reader and a new store, and the
// replacement read settles a tick later; an answer carried across that interval is
// the previous window's participant looked up in this window's roster. The
// input-change cases below are that interval, and they are why the settled identity
// carries the pair it was read against.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { refuse } from "../core/index.js";
import {
  CALLER_IDENTITY_READ_FAILED,
  useCallerMembershipRole,
  type CallerParticipantReader,
  type MembershipRoleReader,
} from "./hooks.js";
import { SessionStore } from "./session-store.js";

/** A store whose roster holds exactly the participants given, with their roles. */
function storeWithRoster(rolesByParticipantId: Readonly<Record<string, string>>): SessionStore {
  const store = new SessionStore({ sessionId: "session-1" });
  store.initialise({
    cursor: 0,
    entities: Object.entries(rolesByParticipantId).map(([participantId, role]) => ({
      kind: "participant" as const,
      id: participantId,
      body: { role },
    })),
    participantJoinLog: Object.keys(rolesByParticipantId),
  });
  return store;
}

/**
 * A double for the roster-role PORT, not for the narrowing behind it.
 *
 * The hook under test chains an identity read to a roster lookup and decides neither
 * — which participant it is comes from the injected reader, and what a body member
 * means comes from the injected lookup. The real lookup narrows against the
 * registered wire shape and is driven by `bridge/entity-body-reads.test.ts`; driving
 * it here as well would test that module twice and this one not at all.
 */
const readRosterRole: MembershipRoleReader = (participant) => {
  const role = participant?.body?.["role"];
  return typeof role === "string" ? (role as ReturnType<MembershipRoleReader>) : undefined;
};

/** The rendered answer, flattened to one string so a case reads as one assertion. */
function Caller(props: {
  readonly read: CallerParticipantReader;
  readonly store: SessionStore;
}): React.JSX.Element {
  const result = useCallerMembershipRole(props.read, props.store, readRosterRole);
  const detail =
    result.status === "read"
      ? `${result.participantId}:${result.role ?? "no-role"}`
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

describe("useCallerMembershipRole — the caller read chained to the roster", () => {
  it("answers the caller's own role once the read lands", async () => {
    const store = storeWithRoster({ "participant-1": "owner", "participant-2": "viewer" });
    const { answer } = await renderCaller(() => Promise.resolve("participant-2"), store);
    expect(answer()).toBe("read|participant-2:viewer");
  });

  it("holds the not-loaded arm while the read is in flight", async () => {
    const store = storeWithRoster({ "participant-1": "owner" });
    // A read that never settles: the arm before an answer is a real answer, and a
    // surface renders it as the "not loaded" kind of nothing rather than as a role.
    const view = render(<Caller read={() => new Promise(() => undefined)} store={store} />);
    expect(view.getByTestId("caller").textContent).toBe("not-loaded|");
  });

  it("carries the refusal rather than an absent role when the read is refused", async () => {
    const store = storeWithRoster({ "participant-1": "owner" });
    const refusal = refuse("growth-port", "wire-unregistered", "Not checked on this build.");
    const { answer } = await renderCaller(() => Promise.resolve(refusal), store);
    expect(answer()).toBe("refused|wire-unregistered");
  });

  it("answers the read arm with no role when the roster holds no entry for the caller", async () => {
    // The read landed and the lookup found nothing — a third fact, and not the
    // same as either of the two above.
    const store = storeWithRoster({ "participant-1": "owner" });
    const { answer } = await renderCaller(() => Promise.resolve("participant-9"), store);
    expect(answer()).toBe("read|participant-9:no-role");
  });

  it("follows a role that changes on the wire without asking who the caller is again", async () => {
    const store = storeWithRoster({ "participant-1": "viewer" });
    let reads = 0;
    const read: CallerParticipantReader = () => {
      reads += 1;
      return Promise.resolve("participant-1");
    };
    const { answer, rerender } = await renderCaller(read, store);
    expect(answer()).toBe("read|participant-1:viewer");

    await act(async () => {
      store.initialise({
        cursor: 1,
        entities: [{ kind: "participant", id: "participant-1", body: { role: "collaborator" } }],
        participantJoinLog: ["participant-1"],
      });
    });
    expect(answer()).toBe("read|participant-1:collaborator");

    rerender();
    expect(reads).toBe(1);
    // And the answer survives that re-render. A hook that compared its stored
    // inputs by anything but identity — or re-stamped them on every pass — would
    // read as "not loaded" here on every frame, which is the opposite failure to
    // the one the input-change cases below are about.
    expect(answer()).toBe("read|participant-1:collaborator");
  });

  it("negative control: never takes the roster's only entry as the caller", async () => {
    // A hook that guessed would answer `owner` here, which is the whole failure:
    // one person shown another person's controls. The read names participant-9 and
    // the roster holds participant-1, so the honest answer is no role at all.
    const store = storeWithRoster({ "participant-1": "owner" });
    const { answer } = await renderCaller(() => Promise.resolve("participant-9"), store);
    expect(answer()).not.toContain("owner");
  });

  it("negative control: a refusal is not reported as a read with no role", async () => {
    // Without this, the refused case would pass over a hook that dropped the
    // refusal and answered the `read` arm with `undefined` — a surface would then
    // render "no role" for a question nothing was ever able to ask.
    const store = storeWithRoster({ "participant-1": "owner" });
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

describe("useCallerMembershipRole — a reader that rejects rather than refusing", () => {
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
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      runnerHost.process.off("unhandledRejection", record);
    }
    return escaped;
  }

  it("answers the refused arm with a stable code when the read rejects", async () => {
    const store = storeWithRoster({ "participant-1": "owner" });
    const { answer } = await renderCaller(
      () => Promise.reject(new Error("the identity call never reached the daemon")),
      store,
    );
    expect(answer()).toBe(`refused|${CALLER_IDENTITY_READ_FAILED}`);
  });

  it("answers the refused arm when the reader throws before it returns a promise", async () => {
    // A synchronous throw is the same failure arriving one tick earlier, and the
    // `try` has to cover the CALL and not only the `await` for it to be caught.
    const store = storeWithRoster({ "participant-1": "owner" });
    const { answer } = await renderCaller(() => {
      throw new Error("the reader was constructed against a bridge that is gone");
    }, store);
    expect(answer()).toBe(`refused|${CALLER_IDENTITY_READ_FAILED}`);
  });

  it("negative control: the rejection reaches no unhandled-rejection report", async () => {
    // The half `answer()` cannot see. On the old effect the rejection escaped the
    // detached async body, this listener recorded it, and the hook additionally sat
    // in `not-loaded` for the life of the pane.
    const store = storeWithRoster({ "participant-1": "owner" });
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
    const firstStore = storeWithRoster({ "participant-1": "owner" });
    const secondStore = storeWithRoster({ "participant-2": "owner" });
    const { answer, rerender } = await renderCaller(firstRead, firstStore);
    expect(answer()).toBe("not-loaded|");

    rerender({ read: () => Promise.resolve("participant-2"), store: secondStore });
    await act(async () => undefined);
    expect(answer()).toBe("read|participant-2:owner");

    const escaped = await unhandledRejectionsDuring(async () => {
      await act(async () => {
        rejectFirstRead(new Error("the abandoned read failed long after it stopped mattering"));
      });
    });
    expect(answer()).toBe("read|participant-2:owner");
    expect(escaped).toEqual([]);
  });
});

describe("useCallerMembershipRole — an answer belongs to the inputs that produced it", () => {
  it("reverts to not-loaded when the reader changes, until the replacement lands", async () => {
    // Both rosters hold `participant-1`, at DIFFERENT roles — which is what makes
    // the held-over answer dangerous rather than merely stale: the old id resolves
    // in the new store, so the hook would report a role for a session that never
    // established this participant.
    const firstStore = storeWithRoster({ "participant-1": "owner" });
    const secondStore = storeWithRoster({ "participant-1": "viewer", "participant-2": "owner" });
    const { answer, rerender } = await renderCaller(
      () => Promise.resolve("participant-1"),
      firstStore,
    );
    expect(answer()).toBe("read|participant-1:owner");

    const replacement = deferredRead();
    rerender({ read: replacement.read, store: secondStore });
    expect(answer()).toBe("not-loaded|");

    await act(async () => {
      replacement.settle("participant-2");
    });
    expect(answer()).toBe("read|participant-2:owner");
  });

  it("reverts to not-loaded when only the store changes", async () => {
    // The reader is unchanged and the store is not, which is the shape a second
    // session on one bridge takes. An identity is an answer about a participant IN
    // a roster, so it is no more transferable across stores than across readers.
    const firstStore = storeWithRoster({ "participant-1": "owner" });
    const secondStore = storeWithRoster({ "participant-1": "viewer" });
    const read: CallerParticipantReader = () => Promise.resolve("participant-1");
    const { answer, rerender } = await renderCaller(read, firstStore);
    expect(answer()).toBe("read|participant-1:owner");

    // The re-render flushes effects but not the microtask the read settles on, so
    // this is exactly the interval the old hook rendered the previous answer in.
    rerender({ read, store: secondStore });
    expect(answer()).toBe("not-loaded|");

    await act(async () => undefined);
    expect(answer()).toBe("read|participant-1:viewer");
  });

  it("discards a first read that lands after the inputs moved on", async () => {
    // The abandonment guard, pinned: a settlement that arrives after the switch
    // must not overwrite the answer the current inputs produced, and must not
    // re-enter the loading arm either.
    const first = deferredRead();
    const firstStore = storeWithRoster({ "participant-1": "owner" });
    const secondStore = storeWithRoster({ "participant-1": "viewer", "participant-2": "owner" });
    const { answer, rerender } = await renderCaller(first.read, firstStore);
    expect(answer()).toBe("not-loaded|");

    rerender({ read: () => Promise.resolve("participant-2"), store: secondStore });
    await act(async () => undefined);
    expect(answer()).toBe("read|participant-2:owner");

    await act(async () => {
      first.settle("participant-1");
    });
    expect(answer()).toBe("read|participant-2:owner");
  });
});
