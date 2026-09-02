// The mutation coordinator: what is in flight, whose refusal it was, and which
// reply is allowed to win.
//
// The property worth the most here is the last one. Two presses against the same
// row race, and a superseded reply overwriting the current one would show the
// wrong outcome for the wrong attempt — silently, because both replies are
// well-formed. Nothing in the rendered tree would say which one landed.

import { describe, expect, it, vi } from "vitest";

import { WireMutationCoordinator } from "./mutation-coordinator.js";

interface Settleable {
  readonly promise: Promise<string>;
  readonly resolve: (value: string) => void;
  readonly reject: (reason: unknown) => void;
}

function settleable(): Settleable {
  let resolve: (value: string) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<string>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function coordinatorOver(
  perform: (request: string) => Promise<string>,
): WireMutationCoordinator<string, string> {
  return new WireMutationCoordinator<string, string>({ perform, describeWhat: "The change" });
}

describe("wire mutation coordinator — what is in flight", () => {
  it("names the subject while its call is unsettled and clears it when it lands", async () => {
    const pending = settleable();
    const coordinator = coordinatorOver(async () => await pending.promise);
    const run = coordinator.run("membership-1", "request");
    expect(coordinator.snapshot().pendingKey).toBe("membership-1");
    pending.resolve("applied");
    await run;
    expect(coordinator.snapshot().pendingKey).toBeUndefined();
  });

  it("negative control: a coordinator nobody ran names no subject", () => {
    // Without this, the case above would pass over an implementation that always
    // reported the key it was last handed, settled or not.
    const coordinator = coordinatorOver(async () => await Promise.resolve("applied"));
    expect(coordinator.snapshot().pendingKey).toBeUndefined();
  });

  it("hands back the response on the applied arm and nothing on the refused one", async () => {
    const applied = coordinatorOver(async () => await Promise.resolve("applied"));
    await expect(applied.run("membership-1", "request")).resolves.toBe("applied");
    const refused = coordinatorOver(async () => await Promise.reject(new Error("no")));
    await expect(refused.run("membership-1", "request")).resolves.toBeUndefined();
  });
});

describe("wire mutation coordinator — whose refusal it was", () => {
  it("keys the refusal to the subject that provoked it", async () => {
    const coordinator = coordinatorOver(async (request: string) =>
      request === "bad"
        ? await Promise.reject({ code: "membership.last_owner", message: "refused" })
        : await Promise.resolve("applied"),
    );
    await coordinator.run("membership-1", "bad");
    await coordinator.run("membership-2", "good");
    const { refusalByKey } = coordinator.snapshot();
    expect(refusalByKey["membership-1"]?.code).toBe("membership.last_owner");
    expect(refusalByKey["membership-2"]).toBeUndefined();
  });

  it("negative control: a served call leaves no refusal behind at all", async () => {
    const coordinator = coordinatorOver(async () => await Promise.resolve("applied"));
    await coordinator.run("membership-1", "good");
    expect(Object.keys(coordinator.snapshot().refusalByKey)).toStrictEqual([]);
  });

  it("drops the prior refusal when the same subject is attempted again", async () => {
    const pending = settleable();
    let attempt = 0;
    const coordinator = coordinatorOver(async () => {
      attempt += 1;
      return attempt === 1 ? await Promise.reject(new Error("no")) : await pending.promise;
    });
    await coordinator.run("membership-1", "first");
    expect(coordinator.snapshot().refusalByKey["membership-1"]).toBeDefined();
    const second = coordinator.run("membership-1", "second");
    // Read WHILE the second attempt is unsettled: a person pressing again must not
    // be reading last time's reason beside this time's spinner.
    expect(coordinator.snapshot().refusalByKey["membership-1"]).toBeUndefined();
    pending.resolve("applied");
    await second;
  });

  it("dismisses one subject's refusal and leaves the others standing", async () => {
    const coordinator = coordinatorOver(async () => await Promise.reject(new Error("no")));
    await coordinator.run("membership-1", "request");
    await coordinator.run("membership-2", "request");
    coordinator.dismiss("membership-1");
    expect(coordinator.snapshot().refusalByKey["membership-1"]).toBeUndefined();
    expect(coordinator.snapshot().refusalByKey["membership-2"]).toBeDefined();
  });

  it("wears the wire code, not a class name", async () => {
    // The envelope's code is what a person pastes into a search. Rendering
    // `Error` there would be the console losing the only machine-readable part.
    const coordinator = coordinatorOver(
      async () =>
        await Promise.reject({ code: "membership.permission_denied", message: "not an owner" }),
    );
    await coordinator.run("membership-1", "request");
    const refusal = coordinator.snapshot().refusalByKey["membership-1"];
    expect(refusal?.code).toBe("membership.permission_denied");
    expect(refusal?.detail).toContain("not an owner");
    expect(refusal?.origin).toBe("collaboration");
  });

  it("survives a rejection that is not a value `String` can render", async () => {
    // A surface whose job is to SHOW a refusal must not throw while building one.
    const hostile = Object.create(null) as object;
    const coordinator = coordinatorOver(async () => await Promise.reject(hostile));
    await coordinator.run("membership-1", "request");
    expect(coordinator.snapshot().refusalByKey["membership-1"]).toBeDefined();
  });
});

describe("wire mutation coordinator — which reply wins", () => {
  it("ignores a superseded reply and keeps the latest attempt's outcome", async () => {
    const first = settleable();
    const second = settleable();
    const calls = [first, second];
    let index = 0;
    const coordinator = coordinatorOver(async () => {
      const call = calls[index];
      index += 1;
      return call === undefined ? await Promise.resolve("applied") : await call.promise;
    });
    const firstRun = coordinator.run("membership-1", "first");
    const secondRun = coordinator.run("membership-1", "second");
    // The first call refuses AFTER the second was issued. Its refusal is stale.
    first.reject({ code: "membership.not_found", message: "gone" });
    await firstRun;
    second.resolve("applied");
    await secondRun;
    expect(coordinator.snapshot().refusalByKey["membership-1"]).toBeUndefined();
    expect(coordinator.snapshot().pendingKey).toBeUndefined();
  });

  it("negative control: a lone refusal on the same subject IS recorded", async () => {
    // Without this, the case above would pass over an implementation that dropped
    // every refusal rather than only the superseded one.
    const coordinator = coordinatorOver(
      async () => await Promise.reject({ code: "membership.not_found", message: "gone" }),
    );
    await coordinator.run("membership-1", "only");
    expect(coordinator.snapshot().refusalByKey["membership-1"]?.code).toBe("membership.not_found");
  });
});

describe("wire mutation coordinator — how a surface hears about it", () => {
  it("emits on every transition and hands out a stable snapshot between them", async () => {
    const coordinator = coordinatorOver(async () => await Promise.resolve("applied"));
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
    const coordinator = coordinatorOver(async () => await Promise.resolve("applied"));
    const sink = vi.fn();
    coordinator.subscribe(sink);
    coordinator.dismiss("membership-unknown");
    expect(sink).not.toHaveBeenCalled();
  });
});
