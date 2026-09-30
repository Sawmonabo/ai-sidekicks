// The states an act reaches, and the one press that is answered rather than sent.
//
// Each case fails without the class: a boolean renders unattempted and settled alike, and a
// form with no single-flight rule sends a second call while the first is out.

import { describe, expect, it } from "vitest";

import { SingleFlightAct } from "./useSingleFlightAct.js";

/** An attempt whose settlement the case releases when it chooses. */
function heldAttempt(): {
  readonly attempt: (request: string) => Promise<string>;
  readonly release: (value: string) => void;
} {
  let release: ((value: string) => void) | undefined;
  return {
    attempt: async () =>
      await new Promise<string>((resolve) => {
        release = resolve;
      }),
    release: (value) => {
      release?.(value);
    },
  };
}

describe("one act's settlement", () => {
  it("starts unattempted, runs between the press and the settlement, then settles", async () => {
    const held = heldAttempt();
    const act = new SingleFlightAct<string, string>({
      attempt: held.attempt,
      describeWhat: "The act",
    });
    // Unattempted is not the same as settled with nothing.
    expect(act.settlement()).toStrictEqual({ status: "unattempted" });

    const running = act.run("asked");
    expect(act.settlement()).toStrictEqual({ status: "running" });

    held.release("answered");
    await running;
    expect(act.settlement()).toStrictEqual({ status: "settled", answer: "answered" });
  });

  it("answers a second press instead of sending it", async () => {
    const held = heldAttempt();
    let attemptCount = 0;
    const act = new SingleFlightAct<string, string>({
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
    // The console's own rule, so the console's own subsystem; a daemon namespace would
    // blame a wire nothing was sent on.
    expect(refusal?.origin).toBe("session-act");
    expect(refusal?.detail).toContain("The join");

    held.release("answered");
    await running;
  });

  it("leaves the first request in flight while it refuses the second", async () => {
    // Guards publishing the duplicate refusal as the settlement: that replaced `running`
    // while the first call was out, so forms re-enabled their control and admitted a press
    // racing the first.
    const held = heldAttempt();
    const act = new SingleFlightAct<string, string>({
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

    // Not merely unmoved by value: the refusal published nothing, so no subscriber was woken.
    expect(act.settlement()).toStrictEqual({ status: "running" });
    expect(notifications).toBe(1);

    // The first request still settles normally.
    held.release("answered");
    await running;
    expect(act.settlement()).toStrictEqual({ status: "settled", answer: "answered" });
  });

  it("would notice a duplicate press that was let through — the control", async () => {
    // Control: with nothing in flight the second press is put and answers no refusal, so the
    // reading above is single-flight and not a class refusing every second call.
    const act = new SingleFlightAct<string, string>({
      attempt: async (request) => await Promise.resolve(request),
      describeWhat: "The join",
    });

    await act.run("first");
    const refusal = await act.run("second");

    expect(refusal).toBeUndefined();
    expect(act.settlement()).toStrictEqual({ status: "settled", answer: "second" });
  });
});
