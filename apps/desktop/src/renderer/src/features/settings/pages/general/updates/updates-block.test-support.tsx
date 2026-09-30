// The updater doubles and the settled render both updates-block suites drive.

import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import { act, render } from "@testing-library/react";
import type { UpdateState, Unsubscribe } from "@shared/preload-api.js";

import { ManualClock } from "@renderer/lib/clock.js";
import { LiveAnnouncer } from "@renderer/components/LiveAnnouncer/live-announcer.js";
import { LiveAnnouncerProvider } from "@renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { politeText } from "@test/helpers/live-region.js";
import { MACHINE_SETTINGS_DEFAULTS } from "@ai-sidekicks/contracts";
import { UpdatesBlock, type UpdatesBlockProps } from "./UpdatesBlock.js";
import type { UpdaterCalls } from "./updater-reading.js";

/**
 * An updater that reports one state and answers both controls.
 *
 * Typed as the whole updater namespace, so an arm added upstream fails this file to compile.
 */
export function updaterReporting(
  state: UpdateState,
  controls: Partial<Pick<UpdaterCalls, "requestCheck" | "requestDownload" | "requestRestart">> = {},
): UpdaterCalls {
  return {
    getState: () => Promise.resolve(state),
    subscribe: () => () => undefined,
    requestCheck: controls.requestCheck ?? (() => Promise.resolve()),
    requestDownload: controls.requestDownload ?? (() => Promise.resolve()),
    requestRestart: controls.requestRestart ?? (() => Promise.resolve()),
  };
}

/**
 * An updater that pushes on demand, so a case can drive a transition after the first read
 * settled; the handler is captured, not replayed from a script.
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
    requestDownload: () => Promise.resolve(),
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
 * Separate from {@link updaterPushing}, whose read resolves immediately.
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
    requestDownload: () => Promise.resolve(),
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

/** Machine settings as a window reads them before anything was chosen; a press reaches `choose`. */
export function preferencesAtDefaults(
  choose: UpdatesBlockProps["preferences"]["choose"] = () => undefined,
): UpdatesBlockProps["preferences"] {
  return {
    settings: MACHINE_SETTINGS_DEFAULTS,
    isPending: () => false,
    choose,
  };
}

/** Press the block's control with this label, which asks for no confirmation. */
export async function pressControl(block: HTMLElement, label: string): Promise<void> {
  const control = [...block.querySelectorAll("button")].find(
    (button) => button.textContent === label,
  );
  await act(async () => {
    control?.click();
    await crossMacrotaskBoundary();
    await crossMacrotaskBoundary();
  });
}

/**
 * Mount the block under the console's real announcer and let its read settle.
 *
 * The announcer runs on a `ManualClock` so its hold window is frozen. The block is returned,
 * not the render container, because the provider's live regions sit beside it and one carries
 * `role="alert"`.
 */
export async function renderSettled(
  updater: UpdaterCalls,
  preferences: UpdatesBlockProps["preferences"] = preferencesAtDefaults(),
): Promise<{
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
        <UpdatesBlock updater={updater} preferences={preferences} />
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
