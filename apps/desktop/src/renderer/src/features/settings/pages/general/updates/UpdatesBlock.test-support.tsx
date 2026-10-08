// The updater double, the machine-settings service double and the settled render the
// updates-block suite drives. The render binds the window's one updater reading and hands it to the
// block, as the window does.

import { crossMacrotaskBoundary } from "#test/helpers/macrotask-boundary.js";
import { act, render } from "@testing-library/react";
import type { ReactNode } from "react";
import type { UpdateState } from "#shared/preload-api.js";
import type { Clock } from "#renderer/lib/clock.js";

import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { MACHINE_SETTINGS_DEFAULTS } from "@ai-sidekicks/contracts/machine-settings";
import { createFixtureBridge } from "#renderer/services/platform/bridge.fixture.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { PlatformBridgeProvider } from "#renderer/services/platform/PlatformBridgeProvider.js";
import { useMachineSettings } from "#renderer/features/settings/machine/hooks/useMachineSettings.js";
import { useUpdateReading } from "#renderer/store/update/hooks/useUpdateReading.js";
import type { UpdaterCalls } from "#renderer/store/update/reading.js";
import { unscriptedScenario } from "#test/helpers/fixture/bridge.js";
import { UpdatesBlock, type UpdatesBlockProps } from "./UpdatesBlock.js";

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

/** Machine settings read as the defaults with nothing chosen; a press reaches `choose`. */
export function preferencesAtDefaults(
  choose: UpdatesBlockProps["preferences"]["choose"] = () => undefined,
): UpdatesBlockProps["preferences"] {
  return {
    snapshot: {
      reading: { settings: MACHINE_SETTINGS_DEFAULTS },
      pendingMembers: new Set(),
      refusalByMember: new Map(),
      readRefusal: undefined,
    },
    settings: MACHINE_SETTINGS_DEFAULTS,
    isPending: () => false,
    refusalFor: () => undefined,
    choose,
    retry: () => undefined,
    readAgain: () => undefined,
  };
}

/**
 * The service's `machineSettings`, whose feed refuses to open for the first `failedOpenCount`
 * opens and then delivers the defaults; it takes no writes.
 */
export function machineSettingsUnreadable(
  failedOpenCount: number,
): PlatformBridge["machineSettings"] & { readonly opens: number } {
  let opens = 0;
  return {
    get opens(): number {
      return opens;
    },
    read: () => Promise.resolve({ settings: MACHINE_SETTINGS_DEFAULTS }),
    write: () => Promise.reject(new Error("no write is expected")),
    subscribe: (deliver) => {
      opens += 1;
      if (opens <= failedOpenCount) {
        throw new Error("The background service is not connected.");
      }
      deliver({ settings: MACHINE_SETTINGS_DEFAULTS });
      return () => undefined;
    },
  };
}

/**
 * The service's `machineSettings`, whose feed delivers the defaults once and whose writes are
 * rejected with the message `refusal` for the first `refusedWriteCount` and then answered with
 * the auto-update member as written, the only member this block writes.
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
    <UpdatesBlockOnReading updater={updater} preferences={preferences} />,
  );
}

/**
 * Mount the block on this window's real machine-settings binding over `machineSettings`, so a
 * write's answer moves the switch exactly as the store folds it. `announcerClock` lets a case move
 * the announcer's hold, so a repeat of the same words can be told from one that coalesced.
 */
export async function renderOnMachineSettings(
  updater: UpdaterCalls,
  machineSettings: PlatformBridge["machineSettings"],
  announcerClock?: Clock,
): Promise<{ readonly block: HTMLElement; readonly container: HTMLElement }> {
  const bridge: PlatformBridge = { ...freshBridge(), machineSettings };
  return await mountSettled(
    bridge,
    <UpdatesBlockOnMachineSettings updater={updater} bridge={bridge} />,
    announcerClock,
  );
}

/** The block as a page mounts it: its preferences bound to the window's machine settings. */
function UpdatesBlockOnMachineSettings(props: {
  readonly updater: UpdaterCalls;
  readonly bridge: PlatformBridge;
}): React.JSX.Element {
  const preferences = useMachineSettings(props.bridge);
  return <UpdatesBlockOnReading updater={props.updater} preferences={preferences} />;
}

/** The block handed the reading bound over `updater`, as the window binds it once. */
function UpdatesBlockOnReading(props: {
  readonly updater: UpdaterCalls;
  readonly preferences: UpdatesBlockProps["preferences"];
}): React.JSX.Element {
  const reading = useUpdateReading(props.updater);
  return <UpdatesBlock reading={reading} updater={props.updater} preferences={props.preferences} />;
}

/** A fresh fixture bridge per mount, so one case's machine-settings store is never another's. */
function freshBridge(): PlatformBridge {
  return createFixtureBridge({ scenario: unscriptedScenario("updates-block") }).bridge;
}

/** Render under the bridge's provider, which the reading line takes its clock from. */
async function mountSettled(
  bridge: PlatformBridge,
  block: ReactNode,
  announcerClock?: Clock,
): Promise<{ readonly block: HTMLElement; readonly container: HTMLElement }> {
  let rendered: ReturnType<typeof render> | undefined;
  await act(async () => {
    rendered = render(
      <PlatformBridgeProvider bridge={bridge}>
        <LiveAnnouncerProvider {...(announcerClock === undefined ? {} : { clock: announcerClock })}>
          {block}
        </LiveAnnouncerProvider>
      </PlatformBridgeProvider>,
    );
    await crossMacrotaskBoundary();
    await crossMacrotaskBoundary();
  });
  const mounted = rendered as ReturnType<typeof render>;
  return { block: updatesBlockOf(mounted.container), container: mounted.container };
}

/** The block's own element, so a case never reads the announcer's regions by accident. */
function updatesBlockOf(root: HTMLElement): HTMLElement {
  const block = root.querySelector<HTMLElement>('section[aria-label="Application updates"]');
  if (block === null) {
    throw new Error("the updates block did not render");
  }
  return block;
}
