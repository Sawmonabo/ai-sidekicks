// The four states an act reaches, and the one press that is answered rather than sent.
//
// Every case here fails without the class: a form holding a boolean renders the
// unattempted and the settled states identically, and a form with no single-flight
// rule puts a second call on the wire while the first is still out.

import { describe, expect, it } from "vitest";

import { SessionAct } from "./act-settlement.js";
import { refuse } from "../../core/index.js";

/** An attempt whose settlement the case releases when it chooses. */
function heldAttempt(): {
  readonly attempt: (request: string) => Promise<{ status: "served"; value: string }>;
  readonly release: (value: string) => void;
} {
  let release: ((value: string) => void) | undefined;
  return {
    attempt: async () =>
      await new Promise<{ status: "served"; value: string }>((resolve) => {
        release = (value) => {
          resolve({ status: "served", value });
        };
      }),
    release: (value) => {
      release?.(value);
    },
  };
}

describe("one act's settlement", () => {
  it("starts unattempted, which is not the same as settled with nothing", () => {
    const act = new SessionAct<string, string>({
      attempt: async () => await Promise.resolve({ status: "served", value: "answered" }),
      describeWhat: "The act",
    });

    expect(act.settlement()).toStrictEqual({ status: "unattempted" });
  });

  it("runs, then settles with the answer", async () => {
    const act = new SessionAct<string, string>({
      attempt: async (request) => await Promise.resolve({ status: "served", value: request }),
      describeWhat: "The act",
    });

    await act.run("asked");

    expect(act.settlement()).toStrictEqual({ status: "settled", answer: "asked" });
  });

  it("carries the refusal through rather than re-minting one", async () => {
    const refusal = refuse("daemon", "session.not_found", "No session by that identifier.");
    const act = new SessionAct<string, string>({
      attempt: async () => await Promise.resolve({ status: "refused", refusal }),
      describeWhat: "The act",
    });

    await act.run("asked");

    // The same object, not a copy: a refusal re-minted on the way past loses the
    // daemon's own code, which is the only thing telling a person what went wrong.
    expect(act.settlement()).toStrictEqual({ status: "refused", refusal });
  });

  it("is running between the press and the settlement", async () => {
    const held = heldAttempt();
    const act = new SessionAct<string, string>({
      attempt: held.attempt,
      describeWhat: "The act",
    });

    const running = act.run("asked");
    expect(act.settlement()).toStrictEqual({ status: "running" });

    held.release("answered");
    await running;
    expect(act.settlement()).toStrictEqual({ status: "settled", answer: "answered" });
  });

  it("answers a second press instead of sending it", async () => {
    const held = heldAttempt();
    let attemptCount = 0;
    const act = new SessionAct<string, string>({
      attempt: async (request) => {
        attemptCount += 1;
        return await held.attempt(request);
      },
      describeWhat: "The join",
    });

    const running = act.run("first");
    const refusal = await act.run("second");

    expect(attemptCount).toBe(1);
    expect(refusal?.code).toBe("act-in-flight");
    // The console's own rule, so the console's own subsystem — a refusal wearing a
    // daemon namespace would attribute this to a wire nothing was sent on.
    expect(refusal?.origin).toBe("session-act");
    expect(refusal?.detail).toContain("The join");

    held.release("answered");
    await running;
  });

  it("leaves the first request in flight while it refuses the second", async () => {
    // The defect: publishing the duplicate refusal as the SETTLEMENT replaced
    // `running` with `refused` while the first call was still out. Every form
    // reading this act then saw a settled state, re-enabled its control, and
    // admitted a press whose call raced the first to overwrite the settlement.
    const held = heldAttempt();
    const act = new SessionAct<string, string>({
      attempt: held.attempt,
      describeWhat: "The join",
    });
    let notifications = 0;
    act.subscribe(() => {
      notifications += 1;
    });

    const running = act.run("first");
    expect(act.settlement()).toStrictEqual({ status: "running" });
    await act.run("second");

    // Unmoved, and not merely unmoved by value: the refusal published NOTHING, so
    // no subscriber was woken with a state the act was not in.
    expect(act.settlement()).toStrictEqual({ status: "running" });
    expect(notifications).toBe(1);

    // And the first request still settles normally, which is the half a form
    // re-enabled by the old behaviour could no longer be told about.
    held.release("answered");
    await running;
    expect(act.settlement()).toStrictEqual({ status: "settled", answer: "answered" });
  });

  it("would notice a duplicate press that was let through — the control", async () => {
    // The same two presses with nothing in flight: the second one IS put, settles,
    // and answers no refusal — so the reading above is a single-flight reading
    // rather than a class that refuses every second call for any reason.
    const act = new SessionAct<string, string>({
      attempt: async (request) => await Promise.resolve({ status: "served", value: request }),
      describeWhat: "The join",
    });

    await act.run("first");
    const refusal = await act.run("second");

    expect(refusal).toBeUndefined();
    expect(act.settlement()).toStrictEqual({ status: "settled", answer: "second" });
  });

  it("would notice a coordinator that let the second press through", async () => {
    // The negative control: the same two presses with the first one already settled
    // send two calls, so the count above is a real single-flight reading rather than
    // a class that never calls twice for any reason.
    let attemptCount = 0;
    const act = new SessionAct<string, string>({
      attempt: async () => {
        attemptCount += 1;
        return await Promise.resolve({ status: "served", value: "answered" });
      },
      describeWhat: "The act",
    });

    await act.run("first");
    await act.run("second");

    expect(attemptCount).toBe(2);
  });

  it("clears back to unattempted, and says nothing new when already there", () => {
    const act = new SessionAct<string, string>({
      attempt: async () => await Promise.resolve({ status: "served", value: "answered" }),
      describeWhat: "The act",
    });
    let notifications = 0;
    act.subscribe(() => {
      notifications += 1;
    });

    act.clear();
    expect(notifications).toBe(0);
    expect(act.settlement()).toStrictEqual({ status: "unattempted" });
  });
});
