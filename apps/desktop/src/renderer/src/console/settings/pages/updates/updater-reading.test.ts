// The race between the updater's two mouths, driven directly.
//
// The case worth the most is the one the block could never show on its own: a push
// landing while the opening read is still in flight. Through a rendered page that is
// a timing accident; here the opening read is held open by hand, so "the push wins"
// is asserted rather than hoped for.

import { describe, expect, it, vi } from "vitest";

import type { SidekicksBridge, UpdateState, Unsubscribe } from "@ai-sidekicks/contracts";

import { UpdaterReadingHolder } from "./updater-reading.js";

/**
 * An updater whose read is settled by hand and whose pushes are delivered by hand.
 *
 * The real updater namespace rather than a partial object: the holder takes exactly
 * `SidekicksBridge["update"]`, so an arm added upstream fails this file to compile
 * instead of leaving a case driving a shape nobody serves.
 */
function controllableUpdater(): {
  readonly updater: SidekicksBridge["update"];
  readonly settleRead: (state: UpdateState) => void;
  readonly refuseRead: (rejection: unknown) => void;
  readonly push: (state: UpdateState) => void;
  readonly readCount: () => number;
  readonly releaseCount: () => number;
} {
  let settle: ((state: UpdateState) => void) | undefined;
  let refuse: ((rejection: unknown) => void) | undefined;
  let deliver: ((state: UpdateState) => void) | undefined;
  let readCount = 0;
  let releaseCount = 0;
  return {
    updater: {
      getState: () => {
        readCount += 1;
        return new Promise<UpdateState>((resolve, reject) => {
          settle = resolve;
          refuse = reject;
        });
      },
      subscribe: (handler): Unsubscribe => {
        deliver = handler;
        return () => {
          releaseCount += 1;
        };
      },
      requestCheck: () => Promise.resolve(),
      requestRestart: () => Promise.resolve(),
    },
    settleRead: (state) => {
      settle?.(state);
    },
    refuseRead: (rejection) => {
      refuse?.(rejection);
    },
    push: (state) => {
      deliver?.(state);
    },
    readCount: () => readCount,
    releaseCount: () => releaseCount,
  };
}

/** Let a settled or refused read's continuation run. */
async function drain(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("the updater reading — which source wins", () => {
  it("keeps the push when the opening read resolves behind it", async () => {
    const updater = controllableUpdater();
    const holder = new UpdaterReadingHolder(updater.updater);
    holder.open();

    updater.push({ status: "ready" });
    updater.settleRead({ status: "checking" });
    await drain();

    expect(holder.snapshot().reading).toStrictEqual({ kind: "state", state: { status: "ready" } });
    expect(holder.snapshot().source).toBe("push");
  });

  it("installs the opening read when nothing has been pushed", async () => {
    const updater = controllableUpdater();
    const holder = new UpdaterReadingHolder(updater.updater);
    holder.open();

    updater.settleRead({ status: "downloading", percent: 42 });
    await drain();

    expect(holder.snapshot().reading).toStrictEqual({
      kind: "state",
      state: { status: "downloading", percent: 42 },
    });
    expect(holder.snapshot().source).toBe("opening");
  });

  it("negative control: the opening read is discarded and not merely ordered behind", async () => {
    // Without this, a holder that installed whichever answer arrived LAST would pass
    // the first case whenever the push happened to be delivered second — which is
    // exactly the old page, and exactly the ordering a real updater does not promise.
    const updater = controllableUpdater();
    const holder = new UpdaterReadingHolder(updater.updater);
    holder.open();

    updater.push({ status: "ready" });
    await drain();
    updater.settleRead({ status: "idle" });
    await drain();

    expect(holder.snapshot().reading).toStrictEqual({ kind: "state", state: { status: "ready" } });
  });

  it("negative control: a later push still installs over the opening read", async () => {
    // Without this, a holder that latched the first answer it accepted would pass
    // every case above and then freeze the block on its opening reading forever.
    const updater = controllableUpdater();
    const holder = new UpdaterReadingHolder(updater.updater);
    holder.open();

    updater.settleRead({ status: "idle" });
    await drain();
    updater.push({ status: "ready" });

    expect(holder.snapshot().reading).toStrictEqual({ kind: "state", state: { status: "ready" } });
    expect(holder.snapshot().source).toBe("push");
  });

  it("keeps the push when the opening read is refused behind it", async () => {
    const updater = controllableUpdater();
    const holder = new UpdaterReadingHolder(updater.updater);
    holder.open();

    updater.push({ status: "downloading", percent: 7 });
    updater.refuseRead(new Error("the updater is busy"));
    await drain();

    expect(holder.snapshot().reading).toStrictEqual({
      kind: "state",
      state: { status: "downloading", percent: 7 },
    });
  });
});

describe("the updater reading — a feed that was not reached", () => {
  it("settles unreachable in the words the failure arrived in, and asks for no state", () => {
    // The code is this seam's own, because a thrown `Error` carries none: the two
    // legs fail for different reasons and the line has to say which.
    const holder = new UpdaterReadingHolder({
      getState: () => Promise.reject(new Error("update.getState is not implemented")),
      subscribe: () => {
        throw new Error("update.subscribe is not implemented");
      },
      requestCheck: () => Promise.resolve(),
      requestRestart: () => Promise.resolve(),
    });
    holder.open();

    expect(holder.snapshot().reading).toStrictEqual({
      kind: "unreachable",
      refusal: {
        code: "updater-subscribe-failed",
        origin: "updates",
        detail: "update.subscribe is not implemented",
      },
    });
  });

  it("keeps a refused read's own code and message rather than a class name", async () => {
    const updater = controllableUpdater();
    const holder = new UpdaterReadingHolder(updater.updater);
    holder.open();

    updater.refuseRead({ code: "update.unavailable", message: "no feed is configured" });
    await drain();

    // The registered code reaches the reading untouched. It used to be discarded:
    // `wireRejectionToError` puts it on `Error.name` and this seam read only
    // `.message`, so every refusal the updater namespace can raise arrived on screen
    // with the one part rule 9 requires verbatim missing.
    expect(holder.snapshot().reading).toStrictEqual({
      kind: "unreachable",
      refusal: {
        code: "update.unavailable",
        origin: "updates",
        detail: "no feed is configured",
      },
    });
  });

  it("negative control: this leg's own fallback code never displaces a registered one", async () => {
    // Without this, the case above would hold for a seam that labelled every read
    // failure `updater-read-failed` and happened to keep the message.
    const updater = controllableUpdater();
    const holder = new UpdaterReadingHolder(updater.updater);
    holder.open();

    updater.refuseRead({ code: "update.unavailable", message: "no feed is configured" });
    await drain();

    const reading = holder.snapshot().reading;
    expect(reading.kind === "unreachable" ? reading.refusal.code : undefined).not.toBe(
      "updater-read-failed",
    );
  });
});

describe("the updater reading — an opening is released and re-opened", () => {
  it("writes nothing from a released opening's late reply", async () => {
    const updater = controllableUpdater();
    const holder = new UpdaterReadingHolder(updater.updater);
    holder.open();
    holder.close();

    updater.push({ status: "ready" });
    updater.settleRead({ status: "idle" });
    await drain();

    expect(holder.snapshot().reading).toStrictEqual({ kind: "not-read" });
    expect(updater.releaseCount()).toBe(1);
  });

  it("re-opens after a close rather than staying dead", async () => {
    // The shape a React effect cleanup between StrictMode's two invocations takes. A
    // terminal teardown would leave the block reading nothing for the window's life.
    const updater = controllableUpdater();
    const holder = new UpdaterReadingHolder(updater.updater);
    holder.open();
    holder.close();
    holder.open();

    updater.settleRead({ status: "ready" });
    await drain();

    expect(holder.snapshot().reading).toStrictEqual({ kind: "state", state: { status: "ready" } });
    expect(updater.readCount()).toBe(2);
  });

  it("notifies its subscriber once per accepted observation", async () => {
    const updater = controllableUpdater();
    const holder = new UpdaterReadingHolder(updater.updater);
    const sink = vi.fn();
    holder.subscribe(sink);
    holder.open();

    updater.push({ status: "checking" });
    updater.settleRead({ status: "idle" });
    await drain();

    // Two observations arrived and one was discarded, so the discarded one raised no
    // change: a holder that emitted on every reply would re-render on a reading it
    // did not install.
    expect(sink).toHaveBeenCalledTimes(1);
    expect(holder.snapshot().sequence).toBe(1);
  });
});
