// The mutation coordinator: what is in flight, whose refusal it was, and what a
// second press earns while the first is unsettled.
//
// The property worth the most here is the last one, and it is worth the most
// because both of its failures are silent. A second call started beside the first
// discards the first's settlement — including its refusal — so a change that
// failed simply disappears; and a second press dropped on the floor instead is
// indistinguishable from one the daemon ignored. Neither leaves a mark in the
// rendered tree, so the tests read the call count and the keyed refusal rather
// than what is on screen.
//
// WHAT THIS SUITE DELIBERATELY NO LONGER COVERS. How a rejection becomes a
// refusal — a wire envelope's dotted code, a value `String` cannot render, a
// `refusal` getter that throws — is the call door's, and `bridge/
// daemon-reply.rejections.test.ts` holds ten cases of it. The stub here answers
// the door's own closed value, so a case written against it would be asserting
// what the stub was told to say.

import { describe, expect, it, vi } from "vitest";

import { DAEMON_REPLY_REFUSAL_ORIGIN, type DaemonReply } from "../bridge/index.js";
import { refuse } from "../core/index.js";
import { WireMutationCoordinator } from "./mutation-coordinator.js";

interface Settleable {
  readonly promise: Promise<DaemonReply<string>>;
  readonly settle: (reply: DaemonReply<string>) => void;
}

function settleable(): Settleable {
  let settle: (reply: DaemonReply<string>) => void = () => undefined;
  const promise = new Promise<DaemonReply<string>>((resolvePromise) => {
    settle = resolvePromise;
  });
  return { promise, settle };
}

/** The arm the door answers when the daemon applied the change. */
function served(value: string): DaemonReply<string> {
  return { status: "served", value };
}

/** The arm the door answers when it did not — built exactly as the door builds it. */
function refusedWith(code: string, detail: string): DaemonReply<string> {
  return { status: "refused", refusal: refuse(DAEMON_REPLY_REFUSAL_ORIGIN, code, detail) };
}

function coordinatorOver(
  perform: (request: string) => Promise<DaemonReply<string>>,
): WireMutationCoordinator<string, string> {
  return new WireMutationCoordinator<string, string>({ perform, describeWhat: "The change" });
}

describe("wire mutation coordinator — what is in flight", () => {
  it("names the subject while its call is unsettled and clears it when it lands", async () => {
    const pending = settleable();
    const coordinator = coordinatorOver(async () => await pending.promise);
    const run = coordinator.run("membership-1", "request");
    expect(coordinator.snapshot().pendingKey).toBe("membership-1");
    pending.settle(served("applied"));
    await run;
    expect(coordinator.snapshot().pendingKey).toBeUndefined();
  });

  it("negative control: a coordinator nobody ran names no subject", () => {
    // Without this, the case above would pass over an implementation that always
    // reported the key it was last handed, settled or not.
    const coordinator = coordinatorOver(async () => await Promise.resolve(served("applied")));
    expect(coordinator.snapshot().pendingKey).toBeUndefined();
  });

  it("hands back the response on the applied arm and nothing on the refused one", async () => {
    const applied = coordinatorOver(async () => await Promise.resolve(served("applied")));
    await expect(applied.run("membership-1", "request")).resolves.toBe("applied");
    const refused = coordinatorOver(
      async () => await Promise.resolve(refusedWith("membership.last_owner", "refused")),
    );
    await expect(refused.run("membership-1", "request")).resolves.toBeUndefined();
  });
});

describe("wire mutation coordinator — whose refusal it was", () => {
  it("keys the refusal to the subject that provoked it", async () => {
    const coordinator = coordinatorOver(async (request: string) =>
      request === "bad"
        ? await Promise.resolve(refusedWith("membership.last_owner", "refused"))
        : await Promise.resolve(served("applied")),
    );
    await coordinator.run("membership-1", "bad");
    await coordinator.run("membership-2", "good");
    const { refusalByKey } = coordinator.snapshot();
    expect(refusalByKey["membership-1"]?.code).toBe("membership.last_owner");
    expect(refusalByKey["membership-2"]).toBeUndefined();
  });

  it("negative control: a served call leaves no refusal behind at all", async () => {
    const coordinator = coordinatorOver(async () => await Promise.resolve(served("applied")));
    await coordinator.run("membership-1", "good");
    expect(Object.keys(coordinator.snapshot().refusalByKey)).toStrictEqual([]);
  });

  it("drops the prior refusal when the same subject is attempted again", async () => {
    const pending = settleable();
    let attempt = 0;
    const coordinator = coordinatorOver(async () => {
      attempt += 1;
      return attempt === 1
        ? await Promise.resolve(refusedWith("membership.last_owner", "refused"))
        : await pending.promise;
    });
    await coordinator.run("membership-1", "first");
    expect(coordinator.snapshot().refusalByKey["membership-1"]).toBeDefined();
    const second = coordinator.run("membership-1", "second");
    // Read WHILE the second attempt is unsettled: a person pressing again must not
    // be reading last time's reason beside this time's spinner.
    expect(coordinator.snapshot().refusalByKey["membership-1"]).toBeUndefined();
    pending.settle(served("applied"));
    await second;
  });

  it("dismisses one subject's refusal and leaves the others standing", async () => {
    const coordinator = coordinatorOver(
      async () => await Promise.resolve(refusedWith("membership.last_owner", "refused")),
    );
    await coordinator.run("membership-1", "request");
    await coordinator.run("membership-2", "request");
    coordinator.dismiss("membership-1");
    expect(coordinator.snapshot().refusalByKey["membership-1"]).toBeUndefined();
    expect(coordinator.snapshot().refusalByKey["membership-2"]).toBeDefined();
  });

  it("installs the door's refusal verbatim, code, detail, and origin alike", async () => {
    // The door has already read the envelope: its code is what a person pastes
    // into a search and its origin says which seam answered. A coordinator that
    // rebuilt either would relabel the daemon's own refusal as this family's rule,
    // which is exactly what `mutation-in-flight` below is allowed to be and what a
    // wire refusal never is.
    const coordinator = coordinatorOver(
      async () =>
        await Promise.resolve(refusedWith("membership.permission_denied", "not an owner")),
    );
    await coordinator.run("membership-1", "request");
    const refusal = coordinator.snapshot().refusalByKey["membership-1"];
    expect(refusal?.code).toBe("membership.permission_denied");
    expect(refusal?.detail).toContain("not an owner");
    expect(refusal?.origin).toBe(DAEMON_REPLY_REFUSAL_ORIGIN);
  });

  it("negative control: the refusal this family raises ITSELF wears this family's origin", async () => {
    // Without this, the case above would pass over a coordinator that stamped
    // every refusal it published with the door's origin.
    const pending = settleable();
    const coordinator = coordinatorOver(async () => await pending.promise);
    const run = coordinator.run("membership-1", "first");
    await coordinator.run("membership-2", "second");
    expect(coordinator.snapshot().refusalByKey["membership-2"]?.origin).toBe("collaboration");
    pending.settle(served("applied"));
    await run;
  });
});

describe("wire mutation coordinator — one at a time", () => {
  /** A coordinator whose calls settle on demand, counting every one it makes. */
  function countingCoordinator(): {
    readonly coordinator: WireMutationCoordinator<string, string>;
    readonly calls: readonly Settleable[];
    readonly callCount: () => number;
  } {
    const calls: Settleable[] = [];
    const coordinator = coordinatorOver(async () => {
      const call = settleable();
      calls.push(call);
      return await call.promise;
    });
    return { coordinator, calls, callCount: () => calls.length };
  }

  it("puts no second call on the wire while one is unsettled", async () => {
    const { coordinator, calls, callCount } = countingCoordinator();
    const firstRun = coordinator.run("membership-1", "first");
    expect(callCount()).toBe(1);

    await expect(coordinator.run("membership-2", "second")).resolves.toBeUndefined();

    expect(callCount()).toBe(1);
    calls[0]?.settle(served("applied"));
    await firstRun;
  });

  it("refuses the second press against its own subject, naming what is still running", async () => {
    const { coordinator, calls } = countingCoordinator();
    const firstRun = coordinator.run("membership-1", "first");

    await coordinator.run("membership-2", "second");

    const refusal = coordinator.snapshot().refusalByKey["membership-2"];
    expect(refusal?.code).toBe("mutation-in-flight");
    expect(refusal?.origin).toBe("collaboration");
    // The row still running is named, because on a ledger of many rows "one at a
    // time" without a subject is not an answer a person can act on.
    expect(refusal?.detail).toContain("membership-1");
    // The refused press never became the pending one.
    expect(coordinator.snapshot().pendingKey).toBe("membership-1");
    calls[0]?.settle(served("applied"));
    await firstRun;
  });

  it("lets the first call's own refusal reach its own subject when it settles", async () => {
    // The bug this replaces: the second attempt superseded the first, so the
    // first's refusal was discarded as stale and a failed change vanished.
    const { coordinator, calls } = countingCoordinator();
    const firstRun = coordinator.run("membership-1", "first");
    await coordinator.run("membership-2", "second");

    calls[0]?.settle(refusedWith("membership.last_owner", "refused"));
    await firstRun;

    const { refusalByKey, pendingKey } = coordinator.snapshot();
    expect(refusalByKey["membership-1"]?.code).toBe("membership.last_owner");
    expect(refusalByKey["membership-2"]?.code).toBe("mutation-in-flight");
    expect(pendingKey).toBeUndefined();
  });

  it("negative control: once the first settles, the next press DOES reach the wire", async () => {
    // Without this, the three cases above would pass over a coordinator that had
    // stopped calling the wire altogether.
    const { coordinator, calls, callCount } = countingCoordinator();
    const firstRun = coordinator.run("membership-1", "first");
    calls[0]?.settle(served("applied"));
    await firstRun;

    const secondRun = coordinator.run("membership-2", "second");

    expect(callCount()).toBe(2);
    expect(coordinator.snapshot().refusalByKey["membership-2"]).toBeUndefined();
    calls[1]?.settle(served("applied"));
    await expect(secondRun).resolves.toBe("applied");
  });
});

describe("wire mutation coordinator — how a surface hears about it", () => {
  it("emits on every transition and hands out a stable snapshot between them", async () => {
    const coordinator = coordinatorOver(async () => await Promise.resolve(served("applied")));
    const sink = vi.fn();
    const unsubscribe = coordinator.subscribe(sink);
    const before = coordinator.snapshot();
    expect(coordinator.snapshot()).toBe(before);
    await coordinator.run("membership-1", "request");
    // One for the attempt, one for the settlement.
    expect(sink).toHaveBeenCalledTimes(2);
    expect(coordinator.snapshot()).not.toBe(before);
    unsubscribe();
    await coordinator.run("membership-1", "request");
    expect(sink).toHaveBeenCalledTimes(2);
  });

  it("emits nothing for a dismiss of a subject that never refused", () => {
    const coordinator = coordinatorOver(async () => await Promise.resolve(served("applied")));
    const sink = vi.fn();
    coordinator.subscribe(sink);
    coordinator.dismiss("membership-unknown");
    expect(sink).not.toHaveBeenCalled();
  });
});

describe("wire mutation coordinator — the subject moving out from under a call", () => {
  it("publishes nothing when a superseded call finally answers", async () => {
    const pending = settleable();
    const coordinator = coordinatorOver(async () => await pending.promise);
    const run = coordinator.run("membership-1", "request");

    coordinator.supersede();
    expect(coordinator.snapshot().pendingKey).toBeUndefined();

    pending.settle(served("applied"));

    // The caller takes the same arm a refusal takes: there is no subject left to
    // install into, and a response is not a reason to render either.
    await expect(run).resolves.toBeUndefined();
    expect(coordinator.snapshot().pendingKey).toBeUndefined();
  });

  it("publishes no refusal when a superseded call refuses", async () => {
    const pending = settleable();
    const coordinator = coordinatorOver(async () => await pending.promise);
    const run = coordinator.run("membership-1", "request");

    coordinator.supersede();
    pending.settle(refusedWith("membership.last_owner", "refused"));
    await run;

    // A refusal about a row of the subject that was left, rendered against the
    // subject that arrived, would attribute it to a control nobody there pressed.
    expect(coordinator.snapshot().refusalByKey["membership-1"]).toBeUndefined();
  });

  it("drops the refusals already standing, because they name the subject being left", async () => {
    const coordinator = coordinatorOver(
      async () => await Promise.resolve(refusedWith("membership.last_owner", "refused")),
    );
    await coordinator.run("membership-1", "request");
    expect(coordinator.snapshot().refusalByKey["membership-1"]).toBeDefined();

    coordinator.supersede();

    expect(Object.keys(coordinator.snapshot().refusalByKey)).toStrictEqual([]);
  });

  it("negative control: without superseding, that same reply DOES settle in place", async () => {
    // Without this, the three cases above would pass over a coordinator that had
    // stopped publishing anything at all.
    const pending = settleable();
    const coordinator = coordinatorOver(async () => await pending.promise);
    const run = coordinator.run("membership-1", "request");
    pending.settle(served("applied"));
    await expect(run).resolves.toBe("applied");
  });

  it("is idempotent and leaves the coordinator usable for the subject that arrived", async () => {
    const coordinator = coordinatorOver(async () => await Promise.resolve(served("applied")));
    coordinator.supersede();
    coordinator.supersede();

    await expect(coordinator.run("membership-2", "request")).resolves.toBe("applied");
  });

  it("emits nothing for a supersede with nothing in flight and nothing refused", () => {
    const coordinator = coordinatorOver(async () => await Promise.resolve(served("applied")));
    const sink = vi.fn();
    coordinator.subscribe(sink);
    coordinator.supersede();
    expect(sink).not.toHaveBeenCalled();
  });
});
