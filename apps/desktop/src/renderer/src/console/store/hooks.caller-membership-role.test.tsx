// The caller's own role: one injected read, chained to the roster lookup.
//
// The failure this file exists for is a surface offering a control on a role
// nothing established. Three situations answer "not an owner" if they are
// collapsed — the read is in flight, the read was refused, the roster holds no
// entry — and only the third is anything like a fact about the participant. So
// every case below asserts the ARM as well as the role, and the negative controls
// are the two guesses a convenient hook would make: taking the roster's only
// entry as the caller, and treating a refusal as an absent role.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { refuse } from "../core/index.js";
import { useCallerMembershipRole, type CallerParticipantReader } from "./hooks.js";
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

/** The rendered answer, flattened to one string so a case reads as one assertion. */
function Caller(props: {
  readonly read: CallerParticipantReader;
  readonly store: SessionStore;
}): React.JSX.Element {
  const result = useCallerMembershipRole(props.read, props.store);
  const detail =
    result.status === "read"
      ? `${result.participantId}:${result.role ?? "no-role"}`
      : result.status === "refused"
        ? result.refusal.code
        : "";
  return <span data-testid="caller">{`${result.status}|${detail}`}</span>;
}

async function renderCaller(
  read: CallerParticipantReader,
  store: SessionStore,
): Promise<{ readonly answer: () => string; readonly rerender: () => void }> {
  const view = render(<Caller read={read} store={store} />);
  await act(async () => undefined);
  return {
    answer: () => view.getByTestId("caller").textContent ?? "",
    rerender: () => {
      view.rerender(<Caller read={read} store={store} />);
    },
  };
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
