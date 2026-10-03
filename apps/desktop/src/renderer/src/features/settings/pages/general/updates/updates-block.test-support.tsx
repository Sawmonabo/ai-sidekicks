// The updater double and the settled render the updates-block suite drives.

import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import { act, render } from "@testing-library/react";
import type { UpdateState } from "@shared/preload-api.js";

import { LiveAnnouncerProvider } from "@renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
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

/** Machine settings as a window reads them before anything was chosen; a press reaches `choose`. */
export function preferencesAtDefaults(
  choose: UpdatesBlockProps["preferences"]["choose"] = () => undefined,
): UpdatesBlockProps["preferences"] {
  return {
    settings: MACHINE_SETTINGS_DEFAULTS,
    isPending: () => false,
    refusalFor: () => undefined,
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
 * The block is returned, not the render container, because the provider's live regions sit
 * beside it and one carries `role="alert"`.
 */
export async function renderSettled(
  updater: UpdaterCalls,
  preferences: UpdatesBlockProps["preferences"] = preferencesAtDefaults(),
): Promise<{ readonly block: HTMLElement }> {
  let rendered: ReturnType<typeof render> | undefined;
  await act(async () => {
    rendered = render(
      <LiveAnnouncerProvider>
        <UpdatesBlock updater={updater} preferences={preferences} />
      </LiveAnnouncerProvider>,
    );
    await crossMacrotaskBoundary();
    await crossMacrotaskBoundary();
  });
  const mounted = rendered as ReturnType<typeof render>;
  return { block: updatesBlockOf(mounted.container) };
}

/** The block's own element, so a case never reads the announcer's regions by accident. */
function updatesBlockOf(root: HTMLElement): HTMLElement {
  const block = root.querySelector<HTMLElement>('section[aria-label="Application updates"]');
  if (block === null) {
    throw new Error("the updates block did not render");
  }
  return block;
}
