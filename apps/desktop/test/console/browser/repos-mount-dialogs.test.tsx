// The browser tier: the bind dialog, on the two claims happy-dom cannot make.
//
// WHY THIS CANNOT LIVE IN THE UNIT TIER, which is the whole reason the file exists.
// Both claims are about what a real engine REFUSES.
//
//   1. A PORTALLED POPUP LEAVES ITS PARENT. Base UI mounts `Dialog.Popup` into a
//      portal, so the popup is not a descendant of the container the card rendered
//      into. Under happy-dom a case can query the popup off either root and pass, so a
//      dialog that had quietly stopped portalling — rendered inline, clipped by the
//      card's own overflow, painted under the surface beside it — would still be found.
//      Here the two roots are asserted apart.
//   2. A DISABLED CONTROL CANNOT BE FOCUSED. `BindModePicker` renders an excluded mode
//      as a disabled radio carrying the mount's own reason, because the gap must be
//      explicit rather than the row dropped. happy-dom's `focus()` sets
//      `document.activeElement` on any element it is called on, so a picker that had
//      shipped those rows ENABLED would pass a unit case that asserted the ring stayed
//      put. Chromium refuses, and that refusal is the guarantee: a person cannot reach,
//      tab to, or activate a mode the daemon has already excluded.
//
// THE DIALOG IS MOUNTED DIRECTLY rather than through the section, because the claim is
// about the popup and the picker and not about how a card composes them.

import type { WorkspaceExecutionModeCapabilitiesReadResponse } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import { pressKeys, renderSettled } from "../console-harness.js";

import { LiveAnnouncerProvider } from "../../../src/renderer/src/console/primitives/index.js";
import { advanceScenarioUntil } from "../../../src/renderer/src/console/bridge/scenario/runtime/clock.test-support.js";
import {
  bridgeOnClock,
  scriptedRepoOperations,
} from "../../../src/renderer/src/console/repos/repo-operations.test-support.js";
import { BindWorkspaceDialog } from "../../../src/renderer/src/console/repos/mounts/bind/BindWorkspaceDialog.js";
import { SESSION_ID } from "../../../src/renderer/src/console/repos/mounts/repo-mounts.test-support.js";
import { SessionStore } from "../../../src/renderer/src/console/store/index.js";

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
  readonly bridge: ReturnType<typeof bridgeOnClock>;
}> {
  const bridge = bridgeOnClock();
  const operations = scriptedRepoOperations({
    readMountExecutionModes: () => Promise.resolve(BOUND_ROOT_ONLY_MODES),
  });
  const { container } = await renderSettled(
    <LiveAnnouncerProvider>
      <BindWorkspaceDialog
        bridge={bridge}
        operations={operations}
        repoMountId={MOUNT_ID}
        canonicalRoot={MOUNT_ROOT}
        sessionStore={new SessionStore({ sessionId: SESSION_ID })}
        onBound={() => undefined}
      />
    </LiveAnnouncerProvider>,
  );
  const trigger = container.querySelector<HTMLButtonElement>(".meridian-bind__trigger");
  expect(trigger).not.toBeNull();
  // Focus and Enter rather than a synthetic click: a `<button>` activated from the
  // keyboard is the same act a person performs, and it needs no helper of its own.
  trigger?.focus();
  await pressKeys("{Enter}");
  return { container, bridge };
}

describe("browser — the bind dialog's popup leaves the card it was opened from", () => {
  it("portals the popup out of the container the trigger rendered into", async () => {
    const { container } = await openBindDialog();
    const portalled = document.querySelector(".meridian-bind__dialog");
    expect(portalled).not.toBeNull();
    // The claim, and the half a unit engine cannot make: the popup is in the document
    // and is NOT under the card. A dialog rendered inline would satisfy the first and
    // fail here, which is the regression this case exists for.
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
    const { bridge } = await openBindDialog();
    let excluded: HTMLInputElement | null = null;
    await advanceScenarioUntil(bridge, () => {
      excluded = document.querySelector<HTMLInputElement>(
        `.meridian-bind__modes input[value="${EXCLUDED_MODE}"]`,
      );
      expect(excluded).not.toBeNull();
    });
    const row: HTMLInputElement = excluded as unknown as HTMLInputElement;
    expect(row.disabled).toBe(true);
    // The row is still on screen with the mount's own sentence beside it: the gap is
    // explicit rather than a mode that silently went missing.
    expect(row.closest(".meridian-bind__mode")?.textContent).toContain(EXCLUSION_REASON);

    const before = document.activeElement;
    row.focus();
    // Chromium refuses to focus a disabled control. This is the assertion happy-dom
    // would pass against a picker that shipped these rows enabled.
    expect(document.activeElement).toBe(before);
    expect(row.checked).toBe(false);
  });

  it("negative control: an admitted mode on the same picker does take the focus", async () => {
    const { bridge } = await openBindDialog();
    let admitted: HTMLInputElement | null = null;
    await advanceScenarioUntil(bridge, () => {
      admitted = document.querySelector<HTMLInputElement>(
        `.meridian-bind__modes input[value="${ADMITTED_MODE}"]`,
      );
      expect(admitted).not.toBeNull();
    });
    const row: HTMLInputElement = admitted as unknown as HTMLInputElement;
    row.focus();
    // Without this the case above would pass against a picker whose radios were all
    // unreachable — including the one the mount does admit.
    expect(document.activeElement).toBe(row);
  });
});
