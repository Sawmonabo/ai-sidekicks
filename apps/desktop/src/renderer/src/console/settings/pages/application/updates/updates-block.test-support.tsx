// The cast both updates-block suites drive the five arms with.
//
// Hoisted because the suite splits on the block's own seam — what it reads, and what
// its controls do — and both halves need the same updater namespace replacement, the
// same refusing preference carrier, and the same settled render. A second copy of the
// updater stub is two files disagreeing about what the shipped bridge serves.

import { crossMacrotaskBoundary } from "../../../../core/macrotask-boundary.test-support.js";
import { act, render } from "@testing-library/react";
import type { ReactNode } from "react";

import type { SidekicksBridge, UpdateState, Unsubscribe } from "@ai-sidekicks/contracts";

import { ManualClock } from "../../../../core/index.js";
import type { SessionStore } from "../../../../store/index.js";
import { LiveAnnouncer, LiveAnnouncerProvider } from "../../../../primitives/index.js";
import { politeText } from "../../../../primitives/live-region.test-support.js";
import {
  fixtureBridgeWithGrowth,
  growthRefusing,
  unscriptedScenario,
} from "../../../../bridge/fixture/fixture-bridge.test-support.js";
import { UpdatesBlock } from "./UpdatesBlock.js";
import type { ConsoleBridge, GrowthPort } from "../../../../bridge/index.js";
import type { ConsoleScenario } from "../../../../bridge/scenario-runtime/scenario.js";

export const SCENARIO: ConsoleScenario = unscriptedScenario("updates-page-test");

/**
 * The preference carrier nobody has registered.
 *
 * The block's automatic-update toggle rides it, so every case here needs it to
 * answer; the refusal is the shipped port's own, not a literal written out beside a
 * value nothing checks it against.
 */
export const REFUSING_CARRIER: Partial<GrowthPort> = {
  shellConfigRead: growthRefusing("shellConfigRead"),
  shellConfigWrite: growthRefusing("shellConfigWrite"),
};

/**
 * The shipped fixture bridge with its updater namespace replaced.
 *
 * The updater is the one seam these cases drive, and it is NOT a growth operation —
 * it is a registered `SidekicksBridge` namespace, so it is replaced here rather than
 * through the growth overrides. Everything else is the fixture's, which is what makes
 * the type annotation load-bearing: an arm added to `UpdateState` upstream fails this
 * file to compile instead of leaving a case asserting against a shape nobody serves.
 */
export function bridgeWithUpdater(update: SidekicksBridge["update"]): ConsoleBridge {
  const fixture = fixtureBridgeWithGrowth(SCENARIO, REFUSING_CARRIER);
  return { ...fixture, sidekicks: { ...fixture.sidekicks, update } };
}

export function bridgeReporting(
  state: UpdateState,
  controls: { requestCheck?: () => Promise<void>; requestRestart?: () => Promise<void> } = {},
): ConsoleBridge {
  return bridgeWithUpdater({
    getState: () => Promise.resolve(state),
    subscribe: () => () => undefined,
    requestCheck: controls.requestCheck ?? (() => Promise.resolve()),
    requestRestart: controls.requestRestart ?? (() => Promise.resolve()),
  });
}

/** A bridge whose updater cannot be reached at all — the shipped Tier-1 posture. */
export function bridgeWithNoUpdater(): ConsoleBridge {
  return bridgeWithUpdater({
    getState: () => Promise.reject(new Error("update.getState is not implemented")),
    subscribe: () => {
      throw new Error("update.subscribe is not implemented");
    },
    requestCheck: () => Promise.resolve(),
    requestRestart: () => Promise.resolve(),
  });
}

/**
 * A bridge whose updater pushes on demand, so a case can drive a second transition.
 *
 * The handler is captured rather than replayed from a script, because what these
 * cases need is a push that lands AFTER the first read settled — which is exactly the
 * moment a page that announced on every state change would speak a second time.
 */
export function bridgePushing(initial: UpdateState): {
  readonly bridge: ConsoleBridge;
  readonly push: (state: UpdateState) => void;
} {
  let deliver: ((state: UpdateState) => void) | undefined;
  const bridge = bridgeWithUpdater({
    getState: () => Promise.resolve(initial),
    subscribe: (handler): Unsubscribe => {
      deliver = handler;
      return () => undefined;
    },
    requestCheck: () => Promise.resolve(),
    requestRestart: () => Promise.resolve(),
  });
  return {
    bridge,
    push: (state) => {
      deliver?.(state);
    },
  };
}

/**
 * A bridge whose opening read is settled by hand, so a push can land ahead of it.
 *
 * Separate from {@link bridgePushing} rather than an option on it: that builder's
 * read resolves immediately, which is what its own cases need, and the case here
 * needs the opposite — a read still in flight when the updater pushes, which is the
 * moment an unconditional continuation overwrites the newer state with the older.
 */
export function bridgeHoldingItsRead(): {
  readonly bridge: ConsoleBridge;
  readonly push: (state: UpdateState) => void;
  readonly settleRead: (state: UpdateState) => void;
} {
  let deliver: ((state: UpdateState) => void) | undefined;
  let settle: ((state: UpdateState) => void) | undefined;
  const bridge = bridgeWithUpdater({
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
  });
  return {
    bridge,
    push: (state) => {
      deliver?.(state);
    },
    settleRead: (state) => {
      settle?.(state);
    },
  };
}

/**
 * Press Check now and let the press settle.
 *
 * Written once because four cases perform it: a control whose failure is a
 * synchronous throw and one whose failure is a rejection have to be pressed the same
 * way, or the two arms would be comparing presses rather than failures.
 */
export async function pressCheckNow(block: HTMLElement): Promise<void> {
  const check = [...block.querySelectorAll("button")].find(
    (button) => button.textContent === "Check now",
  );
  await act(async () => {
    check?.click();
    await crossMacrotaskBoundary();
    await crossMacrotaskBoundary();
  });
}

/**
 * Open the restart confirmation and leave it open, so a case can read what it says.
 *
 * The trigger is the block's own button; the popup it opens is PORTALLED to the
 * document, which is why {@link restartDialog} looks for it there.
 */
export async function openRestartConfirmation(block: HTMLElement): Promise<void> {
  const trigger = [...block.querySelectorAll("button")].find(
    (button) => button.textContent === "Restart to apply",
  );
  await act(async () => {
    trigger?.click();
    await crossMacrotaskBoundary();
  });
}

/** The confirmation's own popup, or `null` while it is closed. It is portalled. */
export function restartDialog(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(".meridian-settings-confirm");
}

/**
 * Open the restart confirmation and answer it.
 *
 * TWO PRESSES, because a restart is two acts now: the trigger states the consequence
 * and the answer settles it. Written here rather than in each case so a suite cannot
 * accidentally assert on a restart that was never confirmed — which is exactly the
 * shape the cases below are checking for.
 *
 * Exact text equality separates the three buttons in the document: the trigger says
 * "Restart to apply", the confirm says "Restart", the cancel says "Not now".
 */
export async function answerRestartConfirmation(
  block: HTMLElement,
  answer: "Restart" | "Not now",
): Promise<void> {
  await openRestartConfirmation(block);
  const settle = [...document.body.querySelectorAll("button")].find(
    (button) => button.textContent === answer,
  );
  await act(async () => {
    settle?.click();
    await crossMacrotaskBoundary();
    await crossMacrotaskBoundary();
  });
}

/** The block's own element, so a case never reads the announcer's regions by accident. */
export function updatesBlockOf(root: HTMLElement): HTMLElement {
  const block = root.querySelector<HTMLElement>('section[aria-label="Application updates"]');
  if (block === null) {
    throw new Error("the updates block did not render");
  }
  return block;
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
 *
 * It hands back the transport swap and the teardown as well as the block, because a
 * suite that mounted its own tree to reach either had a second copy of this mount and
 * the two disagreed about which announcer clock the block runs on.
 */
export async function renderSettled(
  bridge: ConsoleBridge,
  retainedSessionStore?: SessionStore,
): Promise<{
  readonly block: HTMLElement;
  readonly clock: ManualClock;
  readonly politeText: () => string;
  /** The automatic-update switch, re-queried on each call so a swap is visible. */
  readonly toggle: () => HTMLElement | null;
  /** Re-render this same tree against another transport, and let it settle. */
  readonly swapBridge: (next: ConsoleBridge) => Promise<void>;
  readonly unmount: () => void;
}> {
  const clock = new ManualClock();
  const announcer = new LiveAnnouncer({ clock });
  const treeFor = (transport: ConsoleBridge): ReactNode => (
    <LiveAnnouncerProvider announcer={announcer}>
      <UpdatesBlock bridge={transport} retainedSessionStore={retainedSessionStore} />
    </LiveAnnouncerProvider>
  );
  let rendered: ReturnType<typeof render> | undefined;
  await act(async () => {
    rendered = render(treeFor(bridge));
    await crossMacrotaskBoundary();
    await crossMacrotaskBoundary();
  });
  const mounted = rendered as ReturnType<typeof render>;
  return {
    block: updatesBlockOf(mounted.container),
    clock,
    politeText: () => politeText(mounted.container),
    toggle: () =>
      updatesBlockOf(mounted.container).querySelector<HTMLElement>(
        ".meridian-settings-row__switch",
      ),
    swapBridge: async (next: ConsoleBridge) => {
      await act(async () => {
        mounted.rerender(treeFor(next));
        await crossMacrotaskBoundary();
        await crossMacrotaskBoundary();
      });
    },
    unmount: () => {
      mounted.unmount();
    },
  };
}
