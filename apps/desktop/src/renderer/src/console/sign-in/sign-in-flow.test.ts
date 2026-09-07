// The sign-in flow's four rules, each of which is a shape it must never take.
//
//   1. A CANCELLATION IS TERMINAL. A participant who dismissed the platform dialog
//      has answered the question, and the answer is no — so the refused arm must not
//      fall through to the Device Authorization Grant, which would present a browser
//      sign-in to somebody who just declined to sign in.
//   2. ONE CEREMONY AT A TIME. A second press while one is unsettled must not open a
//      second OS dialog: the platform dialog is modal, and a second request against
//      the same authenticator is a refusal on some hosts and a queued prompt on
//      others — neither of which a person asked for.
//   3. A SUPERSEDED SETTLEMENT PUBLISHES NOWHERE. The dialog belongs to main and
//      outlives this window; a settlement arriving after the card is gone must not
//      write into it.
//   4. THE GRANT WAIT IS REACHABLE ONLY FROM THE HAND-OFF, so it cannot be started
//      for a grant this window never obtained.
//   5. AN ENROLMENT THAT ADDS NOTHING REVOKES NOTHING. Enrolling a second
//      authenticator is an act performed FROM a session, not a second way into one,
//      so a prompt the participant dismissed leaves that session exactly as it was
//      and the refusal is carried beside it. A flow that settled the generic refused
//      arm here signed the participant out for cancelling an optional extra — and
//      dismissing that refusal then walked them to the signed-out card.

import { describe, expect, it } from "vitest";

import { SignInFlow, stateFromOutcome } from "./sign-in-flow.js";
import type { SignInCeremony } from "./ceremony-adapter.js";
import type { WebAuthnCeremonyOutcome } from "../bridge/index.js";

const HANDOFF = { verificationUri: "http://127.0.0.1:8419/callback", userCode: "JQPD-4KTM" };

/**
 * A ceremony that answers whatever the test scripted, in order.
 *
 * Substituted for the adapter rather than for the bridge, because what these cases
 * are about is the flow's own ordering — which is the whole of what this class owns.
 */
class ScriptedCeremony {
  #answers: WebAuthnCeremonyOutcome[];
  public calls: string[] = [];
  #release: (() => void) | undefined;

  public constructor(answers: readonly WebAuthnCeremonyOutcome[]) {
    this.#answers = [...answers];
  }

  /** Hold the next answer until the test releases it, so "in flight" is observable. */
  public hold(): void {
    this.#release = undefined;
  }

  public async signIn(): Promise<WebAuthnCeremonyOutcome> {
    return this.#answer("signIn");
  }

  public async register(): Promise<WebAuthnCeremonyOutcome> {
    return this.#answer("register");
  }

  public async awaitDeviceGrant(): Promise<WebAuthnCeremonyOutcome> {
    return this.#answer("awaitDeviceGrant");
  }

  async #answer(leg: string): Promise<WebAuthnCeremonyOutcome> {
    this.calls.push(leg);
    const next = this.#answers.shift();
    if (next === undefined) {
      throw new Error(`the ceremony was asked for ${leg} more times than the test scripted`);
    }
    if (this.#release !== undefined) {
      this.#release();
    }
    return next;
  }
}

function flowOver(answers: readonly WebAuthnCeremonyOutcome[]): {
  flow: SignInFlow;
  ceremony: ScriptedCeremony;
} {
  const ceremony = new ScriptedCeremony(answers);
  return { flow: new SignInFlow(ceremony as unknown as SignInCeremony), ceremony };
}

describe("what one outcome settles into", () => {
  it.each([
    [{ kind: "authenticated", custody: "durable" } as const, "signed-in"],
    [
      { kind: "fallback-required", probeResult: "no-prf", handoff: HANDOFF } as const,
      "handing-off",
    ],
    [{ kind: "refused", reason: "cancelled" } as const, "refused"],
    [
      {
        kind: "unavailable",
        refusal: { code: "ceremony-unreadable", detail: "d", origin: "sign-in" },
      } as const,
      "unavailable",
    ],
  ])("maps %o to the %s state", (outcome, expected) => {
    expect(stateFromOutcome(outcome).kind).toBe(expected);
  });
});

describe("a cancellation is terminal", () => {
  it("does not open the browser hand-off after the prompt was dismissed", async () => {
    const { flow, ceremony } = flowOver([{ kind: "refused", reason: "cancelled" }]);
    await flow.signIn();
    expect(flow.state.kind).toBe("refused");
    // The wait is reachable only from `handing-off`, so this is a no-op rather than a
    // second ceremony — and the call log is what proves it.
    await flow.awaitDeviceGrant();
    expect(ceremony.calls).toStrictEqual(["signIn"]);
  });

  it("puts the card back to signed out when the refusal is dismissed, asking nothing", async () => {
    const { flow, ceremony } = flowOver([{ kind: "refused", reason: "cancelled" }]);
    await flow.signIn();
    flow.dismissRefusal();
    expect(flow.state).toStrictEqual({ kind: "signed-out" });
    expect(ceremony.calls).toStrictEqual(["signIn"]);
  });
});

describe("the device grant finishes", () => {
  it("waits once from the hand-off and settles into the memory-only session", async () => {
    const { flow, ceremony } = flowOver([
      { kind: "fallback-required", probeResult: "no-prf", handoff: HANDOFF },
      { kind: "authenticated", custody: "memory-only" },
    ]);
    await flow.signIn();
    expect(flow.state).toStrictEqual({
      kind: "handing-off",
      probeResult: "no-prf",
      handoff: HANDOFF,
    });
    await flow.awaitDeviceGrant();
    expect(flow.state).toStrictEqual({ kind: "signed-in", custody: "memory-only" });
    expect(ceremony.calls).toStrictEqual(["signIn", "awaitDeviceGrant"]);
  });
});

describe("one ceremony at a time", () => {
  it("does not start a second while one is unsettled", async () => {
    const { flow, ceremony } = flowOver([{ kind: "authenticated", custody: "durable" }]);
    const first = flow.signIn();
    // Issued while the first is in flight: without the single-flight guard this would
    // open a second OS dialog and exhaust the script.
    const second = flow.signIn();
    await Promise.all([first, second]);
    expect(ceremony.calls).toStrictEqual(["signIn"]);
  });

  it("refuses to enrol from a state that is not signed in", async () => {
    const { flow, ceremony } = flowOver([]);
    await flow.register();
    expect(ceremony.calls).toStrictEqual([]);
    expect(flow.state).toStrictEqual({ kind: "signed-out" });
  });
});

describe("an enrolment that adds nothing revokes nothing", () => {
  it("keeps the session and carries the refusal when the prompt is dismissed", async () => {
    const { flow, ceremony } = flowOver([
      { kind: "authenticated", custody: "durable" },
      { kind: "refused", reason: "cancelled" },
    ]);
    await flow.signIn();
    await flow.register();

    expect(flow.state).toStrictEqual({
      kind: "signed-in",
      custody: "durable",
      enrolmentRefusal: { kind: "refused", reason: "cancelled" },
    });

    // And dismissing it clears the refusal rather than the session: the participant
    // is asking to see the control again, which is what rule 9's dismissal means
    // everywhere else in this family.
    flow.dismissRefusal();
    expect(flow.state).toStrictEqual({ kind: "signed-in", custody: "durable" });
    expect(ceremony.calls).toStrictEqual(["signIn", "register"]);
  });

  it("keeps the session when the build could not run the enrolment at all", async () => {
    const refusal = { code: "ceremony-unreadable", detail: "Nothing answered.", origin: "sign-in" };
    const { flow } = flowOver([
      { kind: "authenticated", custody: "memory-only" },
      { kind: "unavailable", refusal },
    ]);
    await flow.signIn();
    await flow.register();

    expect(flow.state).toStrictEqual({
      kind: "signed-in",
      custody: "memory-only",
      enrolmentRefusal: { kind: "unavailable", refusal },
    });
  });

  it("does not hand a signed-in participant to the browser grant", async () => {
    // The Device Authorization Grant is the way IN for a host with no usable
    // authenticator. Reaching it from an enrolment would offer a browser sign-in to
    // somebody already signed in, so the probe result is carried as a refusal and
    // the wait stays unreachable — which the call log is what proves.
    const { flow, ceremony } = flowOver([
      { kind: "authenticated", custody: "durable" },
      { kind: "fallback-required", probeResult: "no-prf", handoff: HANDOFF },
    ]);
    await flow.signIn();
    await flow.register();

    expect(flow.state).toStrictEqual({
      kind: "signed-in",
      custody: "durable",
      enrolmentRefusal: { kind: "fallback-required", probeResult: "no-prf", handoff: HANDOFF },
    });
    await flow.awaitDeviceGrant();
    expect(ceremony.calls).toStrictEqual(["signIn", "register"]);
  });

  it("takes the new custody and drops the refusal once an enrolment succeeds", async () => {
    const { flow } = flowOver([
      { kind: "authenticated", custody: "durable" },
      { kind: "refused", reason: "verification-failed" },
      { kind: "authenticated", custody: "memory-only" },
    ]);
    await flow.signIn();
    await flow.register();
    await flow.register();

    expect(flow.state).toStrictEqual({ kind: "signed-in", custody: "memory-only" });
  });
});

describe("supersession", () => {
  it("publishes nothing into a card that is gone", async () => {
    const { flow } = flowOver([{ kind: "authenticated", custody: "durable" }]);
    const pending = flow.signIn();
    flow.supersede();
    await pending;
    expect(flow.state.kind).toBe("passkey-in-flight");
  });
});
