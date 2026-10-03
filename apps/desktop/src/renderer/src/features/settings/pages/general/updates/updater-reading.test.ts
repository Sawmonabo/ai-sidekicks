// The race between the updater's two sources, driven directly. A push landing while the
// opening read is in flight is a timing accident through a rendered block; here the read is
// held open by hand so "the push wins" is asserted.

import { describe, expect, it } from "vitest";
import type { UpdateState, Unsubscribe } from "@shared/preload-api.js";

import { UpdaterReadingHolder, type UpdaterCalls } from "./updater-reading.js";

/**
 * An updater whose read is settled by hand and whose pushes are delivered by hand.
 *
 * Typed as the real `UpdaterCalls`, so an arm added upstream fails this file to compile.
 */
function controllableUpdater(): {
  readonly updater: UpdaterCalls;
  readonly settleRead: (state: UpdateState) => void;
  readonly push: (state: UpdateState) => void;
  readonly readCount: () => number;
  readonly releaseCount: () => number;
} {
  let settle: ((state: UpdateState) => void) | undefined;
  let deliver: ((state: UpdateState) => void) | undefined;
  let readCount = 0;
  let releaseCount = 0;
  return {
    updater: {
      getState: () => {
        readCount += 1;
        return new Promise<UpdateState>((resolve) => {
          settle = resolve;
        });
      },
      subscribe: (handler): Unsubscribe => {
        deliver = handler;
        return () => {
          releaseCount += 1;
        };
      },
      requestCheck: () => Promise.resolve(),
      requestDownload: () => Promise.resolve(),
      requestRestart: () => Promise.resolve(),
    },
    settleRead: (state) => {
      settle?.(state);
    },
    push: (state) => {
      deliver?.(state);
    },
    readCount: () => readCount,
    releaseCount: () => releaseCount,
  };
}

/** Let a settled read's continuation run. */
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
  });

  it("negative control: the opening read is discarded and not merely ordered behind", async () => {
    // Guards against a holder that installs whichever answer arrives last, which passes the
    // first case whenever the push happens to be delivered second.
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
    // Guards against a holder that latches the first accepted answer and freezes on it.
    const updater = controllableUpdater();
    const holder = new UpdaterReadingHolder(updater.updater);
    holder.open();

    updater.settleRead({ status: "idle" });
    await drain();
    updater.push({ status: "ready" });

    expect(holder.snapshot().reading).toStrictEqual({ kind: "state", state: { status: "ready" } });
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
    // The shape of a React effect cleanup between StrictMode's two invocations; a terminal
    // teardown would leave the block reading nothing.
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
});
