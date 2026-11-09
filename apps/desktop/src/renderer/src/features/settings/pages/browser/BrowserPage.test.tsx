// Each switch reads its member from the window's machine settings and writes that member alone
// back through the store's one-member write.

import { crossMacrotaskBoundary } from "#test/helpers/macrotask-boundary.js";
import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type {
  MachineSettings,
  MachineSettingsChange,
} from "@ai-sidekicks/contracts/machine/settings";

import { ManualClock } from "#renderer/lib/clock.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { TransportReconnectSignal } from "#renderer/services/transport/reconnect.js";
import { useMachineSettings } from "#renderer/features/settings/machine/hooks/useMachineSettings.js";
import { MACHINE_SETTINGS_AT_DEFAULTS } from "#renderer/features/settings/machine/snapshot.js";
import { BrowserPage } from "./BrowserPage.js";

/** A settings file whose feed delivers `settings` and whose writes answer the file as written. */
function settingsFile(
  settings: MachineSettings,
): PlatformBridge["machineSettings"] & { readonly writes: MachineSettingsChange[] } {
  const writes: MachineSettingsChange[] = [];
  let held = settings;
  return {
    writes,
    read: () => Promise.resolve({ settings: held }),
    write: (change) => {
      writes.push(change);
      held = { ...held, ...change };
      return Promise.resolve(held);
    },
    subscribe: (deliver) => {
      deliver({ settings: held });
      return () => undefined;
    },
  };
}

/** The window's clock; the page reads it only while the file is unread. */
const CLOCK = new ManualClock();

/** The page bound to the window's machine settings, as its body binds it. */
function BrowserPageOn(props: { readonly bridge: PlatformBridge }): React.JSX.Element {
  const preferences = useMachineSettings(props.bridge);
  return <BrowserPage preferences={preferences} clock={CLOCK} />;
}

/** Mount the page over `machineSettings` and let the feed's first delivery install. */
async function renderPage(
  machineSettings: PlatformBridge["machineSettings"],
): Promise<HTMLElement> {
  // The store's holder reads only these two members of the bridge.
  const bridge = {
    machineSettings,
    transportReconnect: new TransportReconnectSignal(),
  } as unknown as PlatformBridge;
  let container: HTMLElement | undefined;
  await act(async () => {
    container = render(<BrowserPageOn bridge={bridge} />).container;
    await crossMacrotaskBoundary();
  });
  if (container === undefined) {
    throw new Error("the page did not render");
  }
  return container;
}

/** The switch the row labeled `label` draws. */
function switchLabeled(page: HTMLElement, label: string): HTMLElement {
  const labelElement = [...page.querySelectorAll("label")].find(
    (candidate) => candidate.textContent === label,
  );
  const switchElement = labelElement
    ?.closest(".meridian-settings-row")
    ?.querySelector('[role="switch"]');
  if (!(switchElement instanceof HTMLElement)) {
    throw new Error(`no switch is labeled ${label}`);
  }
  return switchElement;
}

const ROWS = [
  { label: "Remember site data", member: "rememberSiteData" },
  { label: "Browser tools for sidekicks", member: "browserToolsForAgents" },
  { label: "Sandbox the background browser", member: "sandboxBackgroundBrowser" },
] as const;

describe("Settings › Browser — the three switches", () => {
  it.each(ROWS)("$label reads its member and writes only that member", async (row) => {
    const flipped: MachineSettings = {
      ...MACHINE_SETTINGS_AT_DEFAULTS,
      [row.member]: !MACHINE_SETTINGS_AT_DEFAULTS[row.member],
    };
    const file = settingsFile(flipped);
    const page = await renderPage(file);
    expect(switchLabeled(page, row.label).getAttribute("aria-checked")).toBe(
      String(flipped[row.member]),
    );

    await act(async () => {
      switchLabeled(page, row.label).click();
      await crossMacrotaskBoundary();
    });
    expect(file.writes).toEqual([{ [row.member]: MACHINE_SETTINGS_AT_DEFAULTS[row.member] }]);
    expect(switchLabeled(page, row.label).getAttribute("aria-checked")).toBe(
      String(MACHINE_SETTINGS_AT_DEFAULTS[row.member]),
    );
  });

  it("reads Sandbox the background browser off on a file at its defaults", async () => {
    const page = await renderPage(settingsFile(MACHINE_SETTINGS_AT_DEFAULTS));
    expect(switchLabeled(page, "Sandbox the background browser").getAttribute("aria-checked")).toBe(
      "false",
    );
  });
});
