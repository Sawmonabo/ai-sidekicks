// The updater double, the machine-settings service double and the settled render the
// updates-block suite drives.

import { crossMacrotaskBoundary } from "#test/helpers/macrotask-boundary.js";
import { act, render } from "@testing-library/react";
import type { ReactNode } from "react";
import type { UpdateState } from "#shared/preload-api.js";

import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { MACHINE_SETTINGS_DEFAULTS } from "@ai-sidekicks/contracts/machine-settings";
import { createFixtureBridge } from "#renderer/services/platform/bridge.fixture.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { PlatformBridgeProvider } from "#renderer/services/platform/PlatformBridgeProvider.js";
import { useMachineSettings } from "#renderer/features/settings/machine/hooks/useMachineSettings.js";
import { unscriptedScenario } from "#test/helpers/fixture/bridge.js";
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
    retry: () => undefined,
  };
}

/**
 * The service's `machineSettings`, whose feed delivers the defaults once and whose writes are
 * refused for the first `refusedWriteCount` and then answered with the auto-update member as
 * written, the only member this block writes.
 */
export function machineSettingsRefusing(
  refusedWriteCount: number,
  refusal: string,
): PlatformBridge["machineSettings"] & { readonly writes: unknown[] } {
  const writes: unknown[] = [];
  return {
    writes,
    read: () => Promise.resolve({ settings: MACHINE_SETTINGS_DEFAULTS }),
    write: (change) => {
      writes.push(change);
      return writes.length <= refusedWriteCount
        ? Promise.reject(new Error(refusal))
        : Promise.resolve({
            ...MACHINE_SETTINGS_DEFAULTS,
            updatesAutomatic: change.updatesAutomatic ?? MACHINE_SETTINGS_DEFAULTS.updatesAutomatic,
          });
    },
    subscribe: (deliver) => {
      deliver({ settings: MACHINE_SETTINGS_DEFAULTS });
      return () => undefined;
    },
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
  return await mountSettled(
    freshBridge(),
    <UpdatesBlock updater={updater} preferences={preferences} />,
  );
}

/**
 * Mount the block on this window's real machine-settings binding over `machineSettings`, so a
 * write's answer moves the switch exactly as the store folds it.
 */
export async function renderOnMachineSettings(
  updater: UpdaterCalls,
  machineSettings: PlatformBridge["machineSettings"],
): Promise<{ readonly block: HTMLElement }> {
  const bridge: PlatformBridge = { ...freshBridge(), machineSettings };
  return await mountSettled(
    bridge,
    <UpdatesBlockOnMachineSettings updater={updater} bridge={bridge} />,
  );
}

/** The block as a page mounts it: its preferences bound to the window's machine settings. */
function UpdatesBlockOnMachineSettings(props: {
  readonly updater: UpdaterCalls;
  readonly bridge: PlatformBridge;
}): React.JSX.Element {
  const preferences = useMachineSettings(props.bridge);
  return <UpdatesBlock updater={props.updater} preferences={preferences} />;
}

/** A fresh fixture bridge per mount, so one case's machine-settings store is never another's. */
function freshBridge(): PlatformBridge {
  return createFixtureBridge({ scenario: unscriptedScenario("updates-block") }).bridge;
}

/** Render under the bridge's provider, which the reading line takes its clock from. */
async function mountSettled(
  bridge: PlatformBridge,
  block: ReactNode,
): Promise<{ readonly block: HTMLElement }> {
  let rendered: ReturnType<typeof render> | undefined;
  await act(async () => {
    rendered = render(
      <PlatformBridgeProvider bridge={bridge}>
        <LiveAnnouncerProvider>{block}</LiveAnnouncerProvider>
      </PlatformBridgeProvider>,
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
