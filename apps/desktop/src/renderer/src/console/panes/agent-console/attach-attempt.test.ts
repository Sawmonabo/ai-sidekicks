// The one property `agent.attach` needs and a bare handler cannot give it: a
// second press while the first is outstanding reaches the wire never.
//
// The latch is checked here against a call this file controls, because the failure
// it prevents is invisible against a call that settles: a promise resolved on the
// next microtask makes every ordering look correct. Every case below therefore
// holds the call open and presses again inside that window.

import { describe, expect, it } from "vitest";

import { ConsoleRefusalError, refuse } from "../../core/index.js";
import type { AgentAttachReading } from "../../agents/index.js";
import { AttachAttempt } from "./attach-attempt.js";

const ORIGIN = "attach-attempt-test";

/** A call held open until the test releases it, and a count of how often it ran. */
class HeldAttachCall {
  #callCount = 0;
  #release: ((reading: AgentAttachReading) => void) | undefined;
  #refuse: ((error: unknown) => void) | undefined;

  public get callCount(): number {
    return this.#callCount;
  }

  public readonly perform = async (): Promise<AgentAttachReading> => {
    this.#callCount += 1;
    return await new Promise<AgentAttachReading>((resolve, reject) => {
      this.#release = resolve;
      this.#refuse = reject;
    });
  };

  public async settle(reading: AgentAttachReading): Promise<void> {
    this.#release?.(reading);
    await Promise.resolve();
    await Promise.resolve();
  }

  public async refuseWith(error: unknown): Promise<void> {
    this.#refuse?.(error);
    await Promise.resolve();
    await Promise.resolve();
  }
}

function attached(agentId: string): AgentAttachReading {
  return { agentId };
}

describe("attach attempt — one in flight", () => {
  it("performs one call for two presses inside the same window", () => {
    const call = new HeldAttachCall();
    const attempt = new AttachAttempt({ origin: ORIGIN });

    attempt.submit(call.perform);
    attempt.submit(call.perform);

    expect(call.callCount).toBe(1);
    expect(attempt.state.status).toBe("in-flight");
  });

  it("negative control: the latch re-arms, so a press AFTER settlement calls again", async () => {
    // Without this, the case above would pass over a latch that admitted exactly
    // one attach for the life of the mount — which is a different defect wearing
    // the same green test.
    const call = new HeldAttachCall();
    const attempt = new AttachAttempt({ origin: ORIGIN });

    attempt.submit(call.perform);
    await call.settle(attached("agent-scout"));
    expect(attempt.state).toEqual({ status: "attached", confirmation: attached("agent-scout") });

    attempt.submit(call.perform);
    expect(call.callCount).toBe(2);
  });

  it("shows the settled reply's confirmation rather than the request's own values", async () => {
    const call = new HeldAttachCall();
    const attempt = new AttachAttempt({ origin: ORIGIN });

    attempt.submit(call.perform);
    await call.settle({ agentId: "agent-daemon-minted", resolvedFromDefinitionId: "definition-1" });

    expect(attempt.state).toEqual({
      status: "attached",
      confirmation: { agentId: "agent-daemon-minted", resolvedFromDefinitionId: "definition-1" },
    });
  });
});

describe("attach attempt — a refusal", () => {
  it("renders the daemon's own refusal verbatim and re-arms", async () => {
    const call = new HeldAttachCall();
    const attempt = new AttachAttempt({ origin: ORIGIN });
    const daemonRefusal = refuse("daemon", "sidekick.definition_not_found", "No such definition.");

    attempt.submit(call.perform);
    await call.refuseWith(new ConsoleRefusalError(daemonRefusal));

    expect(attempt.state).toEqual({ status: "refused", refusal: daemonRefusal });

    attempt.submit(call.perform);
    expect(call.callCount).toBe(2);
    expect(attempt.state.status).toBe("in-flight");
  });

  it("names this attempt where the thrown value carried no refusal of its own", async () => {
    const call = new HeldAttachCall();
    const attempt = new AttachAttempt({ origin: ORIGIN });

    attempt.submit(call.perform);
    await call.refuseWith(new Error("the transport closed"));

    expect(attempt.state).toEqual({
      status: "refused",
      refusal: refuse(ORIGIN, "read-failed", "the transport closed"),
    });
  });

  it("drops the previous settlement the moment a new attempt starts", async () => {
    // A surface that kept it would draw last attempt's confirmation beside this
    // attempt's pending state, which reads as an attach that has already happened.
    const call = new HeldAttachCall();
    const attempt = new AttachAttempt({ origin: ORIGIN });

    attempt.submit(call.perform);
    await call.settle(attached("agent-scout"));
    attempt.submit(call.perform);

    expect(attempt.state).toEqual({ status: "in-flight" });
  });
});

describe("attach attempt — the notification", () => {
  it("tells its subscriber on every transition and stops on unsubscribe", async () => {
    const call = new HeldAttachCall();
    const attempt = new AttachAttempt({ origin: ORIGIN });
    let notificationCount = 0;
    const unsubscribe = attempt.onChange(() => {
      notificationCount += 1;
    });

    attempt.submit(call.perform);
    await call.settle(attached("agent-scout"));
    expect(notificationCount).toBe(2);

    unsubscribe();
    attempt.submit(call.perform);
    expect(notificationCount).toBe(2);
  });
});
