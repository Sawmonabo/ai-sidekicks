// The browser tier: the bind dialog, on two claims happy-dom cannot make. The dialog is mounted
// directly, not through the section, because the claims are about the popup and the picker.
//
// 1. A portalled popup leaves its parent. Base UI mounts `Dialog.Popup` into a portal, so it is
//    not a descendant of the container the card rendered into. Under happy-dom the popup is
//    found from either root, so a dialog that stopped portalling would still pass.
// 2. A disabled control cannot be focused. `BindModePicker` renders an excluded mode as a
//    disabled radio carrying the mount's reason. happy-dom's `focus()` succeeds on any element,
//    so a picker that shipped those rows enabled would pass; Chromium refuses, which is the
//    guarantee that a person cannot reach a mode the daemon has excluded.

import type { WorkspaceExecutionModeCapabilitiesReadResponse } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import { pressKeys, renderSettled } from "../helpers/app-harness.js";

import { LiveAnnouncerProvider } from "@renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { advanceScenarioUntil } from "../helpers/scenario-manual-clock.js";
import { bridgeOnClock } from "@test/helpers/fixture-bridge.js";
import { PlatformBridgeProvider } from "@renderer/services/platform/PlatformBridgeProvider.js";
import type { ScenarioEngine } from "@renderer/services/daemon/engine.fixture.js";
import { scriptedRepoOperations } from "@renderer/features/repos/repo-operations.test-support.js";
import { BindWorkspaceDialog } from "@renderer/features/repos/mounts/bind/BindWorkspaceDialog.js";
import { SESSION_ID } from "@renderer/features/repos/mounts/repo-mounts.test-support.js";
import { SessionStore } from "@renderer/store/session/session-store.js";

/** The mount the dialog binds on. Its id only has to match what the scripted read is asked. */
const MOUNT_ID = "mount-sidekicks";

/** The resolved root the dialog shows above its directory field. Displayed, never joined. */
const MOUNT_ROOT = "/Users/dev/code/ai-sidekicks";

/** The mode this mount does not admit. */
const EXCLUDED_MODE = "provisioned-worktree";

/** The mode this mount does admit. */
const ADMITTED_MODE = "bound-root";

/** The daemon's reason for the excluded mode. */
const EXCLUSION_REASON = "this mount cannot host a second checkout";

/** What the mount admits: its own root alone, with the daemon's reason for the rest. */
const BOUND_ROOT_ONLY_MODES: WorkspaceExecutionModeCapabilitiesReadResponse = {
  availableModes: [ADMITTED_MODE],
  defaultMode: ADMITTED_MODE,
  restrictions: { [EXCLUDED_MODE]: EXCLUSION_REASON },
};

/** Mount one bind dialog over a scripted mode read, and open it the way a person does. */
async function openBindDialog(): Promise<{
  readonly container: HTMLElement;
  readonly scenarioEngine: ScenarioEngine;
}> {
  const { bridge, scenarioEngine, clock } = bridgeOnClock("repos");
  const operations = scriptedRepoOperations({
    readMountExecutionModes: () => Promise.resolve(BOUND_ROOT_ONLY_MODES),
  });
  const { container } = await renderSettled(
    <PlatformBridgeProvider bridge={bridge} clock={clock}>
      <LiveAnnouncerProvider>
        <BindWorkspaceDialog
          bridge={bridge}
          operations={operations}
          repoMountId={MOUNT_ID}
          canonicalRoot={MOUNT_ROOT}
          sessionStore={new SessionStore({ sessionId: SESSION_ID })}
          onBound={() => undefined}
        />
      </LiveAnnouncerProvider>
    </PlatformBridgeProvider>,
  );
  const trigger = container.querySelector<HTMLButtonElement>(".meridian-bind__trigger");
  expect(trigger).not.toBeNull();
  // Focus and Enter rather than a synthetic click: the same act a person performs.
  trigger?.focus();
  await pressKeys("{Enter}");
  return { container, scenarioEngine };
}

describe("browser — the bind dialog's popup leaves the card it was opened from", () => {
  it("portals the popup out of the container the trigger rendered into", async () => {
    const { container } = await openBindDialog();
    const portalled = document.querySelector(".meridian-bind__dialog");
    expect(portalled).not.toBeNull();
    // The popup is in the document and not under the card; a dialog rendered inline would
    // satisfy the first and fail here.
    expect(container.querySelector(".meridian-bind__dialog")).toBeNull();
  });

  it("moves the focus ring into the popup rather than leaving it on the trigger", async () => {
    const { container } = await openBindDialog();
    const popup = document.querySelector(".meridian-bind__dialog");
    expect(popup?.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(container.querySelector(".meridian-bind__trigger"));
  });
});

describe("browser — an excluded execution mode cannot be reached", () => {
  it("renders the excluded mode with its reason and refuses the focus", async () => {
    const { scenarioEngine } = await openBindDialog();
    let excluded: HTMLInputElement | null = null;
    await advanceScenarioUntil(scenarioEngine, () => {
      excluded = document.querySelector<HTMLInputElement>(
        `.meridian-bind__modes input[value="${EXCLUDED_MODE}"]`,
      );
      expect(excluded).not.toBeNull();
    });
    const row: HTMLInputElement = excluded as unknown as HTMLInputElement;
    expect(row.disabled).toBe(true);
    // The row stays on screen with the mount's reason beside it, not silently dropped.
    expect(row.closest(".meridian-bind__mode")?.textContent).toContain(EXCLUSION_REASON);

    const before = document.activeElement;
    row.focus();
    // Chromium refuses to focus a disabled control; happy-dom would let it through.
    expect(document.activeElement).toBe(before);
    expect(row.checked).toBe(false);
  });

  it("negative control: an admitted mode on the same picker does take the focus", async () => {
    const { scenarioEngine } = await openBindDialog();
    let admitted: HTMLInputElement | null = null;
    await advanceScenarioUntil(scenarioEngine, () => {
      admitted = document.querySelector<HTMLInputElement>(
        `.meridian-bind__modes input[value="${ADMITTED_MODE}"]`,
      );
      expect(admitted).not.toBeNull();
    });
    const row: HTMLInputElement = admitted as unknown as HTMLInputElement;
    row.focus();
    // Without this the case above would pass against a picker whose radios were all unreachable.
    expect(document.activeElement).toBe(row);
  });
});
