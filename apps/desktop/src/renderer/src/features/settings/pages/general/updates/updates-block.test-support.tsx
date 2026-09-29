// The updater doubles both updates-block suites drive the five arms with.
//
// Hoisted because the suite splits on the block's own seam — what it reads, and what
// its controls do — and both halves need the same updater doubles and the same settled
// render. A second copy of the updater stub is two files disagreeing about what the
// updater serves.

import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import { act, render } from "@testing-library/react";
import type { UpdateState, Unsubscribe } from "@shared/preload-api.js";

import { ManualClock } from "@renderer/lib/clock.js";
import { LiveAnnouncer, LiveAnnouncerProvider } from "@renderer/console/primitives/index.js";
import { politeText } from "@test/helpers/live-region.js";
import { UpdatesBlock } from "@renderer/console/settings/pages/application/updates/UpdatesBlock.js";
import type { UpdaterCalls } from "./updater-reading.js";

/**
 * An updater that reports one state and answers both controls.
 *
 * Typed as the whole updater namespace, so an arm added to `UpdateState` upstream
 * fails this file to compile instead of leaving a case asserting against a shape
 * nobody serves.
 */
export function updaterReporting(
  state: UpdateState,
  controls: { requestCheck?: () => Promise<void>; requestRestart?: () => Promise<void> } = {},
): UpdaterCalls {
  return {
    getState: () => Promise.resolve(state),
    subscribe: () => () => undefined,
    requestCheck: controls.requestCheck ?? (() => Promise.resolve()),
    requestRestart: controls.requestRestart ?? (() => Promise.resolve()),
  };
}

/**
 * An updater that pushes on demand, so a case can drive a second transition.
 *
 * The handler is captured rather than replayed from a script, because what these
 * cases need is a push that lands AFTER the first read settled — which is exactly the
 * moment a page that announced on every state change would speak a second time.
 */
export function updaterPushing(initial: UpdateState): {
  readonly updater: UpdaterCalls;
  readonly push: (state: UpdateState) => void;
} {
  let deliver: ((state: UpdateState) => void) | undefined;
  const updater: UpdaterCalls = {
    getState: () => Promise.resolve(initial),
    subscribe: (handler): Unsubscribe => {
      deliver = handler;
      return () => undefined;
    },
    requestCheck: () => Promise.resolve(),
    requestRestart: () => Promise.resolve(),
  };
  return {
    updater,
    push: (state) => {
      deliver?.(state);
    },
  };
}

/**
 * An updater whose opening read is settled by hand, so a push can land ahead of it.
 *
 * Separate from {@link updaterPushing} rather than an option on it: that builder's
 * read resolves immediately, which is what its own cases need, and the case here
 * needs the opposite — a read still in flight when the updater pushes, which is the
 * moment an unconditional continuation overwrites the newer state with the older.
 */
export function updaterHoldingItsRead(): {
  readonly updater: UpdaterCalls;
  readonly push: (state: UpdateState) => void;
  readonly settleRead: (state: UpdateState) => void;
} {
  let deliver: ((state: UpdateState) => void) | undefined;
  let settle: ((state: UpdateState) => void) | undefined;
  const updater: UpdaterCalls = {
    getState: () =>
      new Promise<UpdateState>((resolve) => {
        settle = resolve;
      }),
    subscribe: (handler): Unsubscribe => {
      deliver = handler;
      return () => undefined;
    },
    requestCheck: () => Promise.resolve(),
    requestRestart: () => Promise.resolve(),
  };
  return {
    updater,
    push: (state) => {
      deliver?.(state);
    },
    settleRead: (state) => {
      settle?.(state);
    },
  };
}

/** Press the block's restart control, which asks for no confirmation. */
export async function pressRestart(block: HTMLElement): Promise<void> {
  const restart = [...block.querySelectorAll("button")].find(
    (button) => button.textContent === "Restart to apply",
  );
  await act(async () => {
    restart?.click();
    await crossMacrotaskBoundary();
    await crossMacrotaskBoundary();
  });
}

/**
 * Mount the block under the console's real announcer and let its read settle.
 *
 * The announcer runs on a `ManualClock` so its hold window is frozen: whether a
 * sentence was said a second time is otherwise a question about how fast the runner
 * happened to be. The BLOCK is returned rather than the render container, because the
 * two live regions are the provider's siblings above it and one of them carries
 * `role="alert"` — a case asserting this block raises no alert would otherwise be
 * reading the announcer's.
 */
export async function renderSettled(updater: UpdaterCalls): Promise<{
  readonly block: HTMLElement;
  readonly clock: ManualClock;
  readonly politeText: () => string;
}> {
  const clock = new ManualClock();
  const announcer = new LiveAnnouncer({ clock });
  let rendered: ReturnType<typeof render> | undefined;
  await act(async () => {
    rendered = render(
      <LiveAnnouncerProvider announcer={announcer}>
        <UpdatesBlock updater={updater} />
      </LiveAnnouncerProvider>,
    );
    await crossMacrotaskBoundary();
    await crossMacrotaskBoundary();
  });
  const mounted = rendered as ReturnType<typeof render>;
  return {
    block: updatesBlockOf(mounted.container),
    clock,
    politeText: () => politeText(mounted.container),
  };
}

/** The block's own element, so a case never reads the announcer's regions by accident. */
function updatesBlockOf(root: HTMLElement): HTMLElement {
  const block = root.querySelector<HTMLElement>('section[aria-label="Application updates"]');
  if (block === null) {
    throw new Error("the updates block did not render");
  }
  return block;
}
