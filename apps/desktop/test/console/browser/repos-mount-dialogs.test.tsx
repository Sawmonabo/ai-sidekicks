// The browser tier: the mounts family's two dialogs, on the two claims happy-dom cannot
// make.
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
//      as a disabled radio carrying the mount's own reason, because `Spec-009 §Fallback
//      Behavior` requires the gap explicit rather than the row dropped. happy-dom's
//      `focus()` sets `document.activeElement` on any element it is called on, so a
//      picker that had shipped those rows ENABLED would pass a unit case that asserted
//      the ring stayed put. Chromium refuses, and that refusal is the guarantee: a
//      person cannot reach, tab to, or activate a mode the daemon has already excluded.
//
// BOTH DIALOGS ARE MOUNTED DIRECTLY rather than through the section, because the claim
// is about the popup and the picker and not about how a card composes them — and a
// fixture small enough to mount whole is the shape where a failure is unambiguous.

import { describe, expect, it } from "vitest";

import { pressKeys, renderSettled } from "../console-harness.js";

import { createFixtureBridge } from "../../../src/renderer/src/console/bridge/index.js";
import { REPOS_SCENARIO } from "../../../src/renderer/src/console/bridge/scenarios/repos.js";
import {
  GIT_MOUNT_ID,
  PLAIN_MOUNT_ID,
} from "../../../src/renderer/src/console/bridge/scenarios/repos-fixture-data.js";
import { LiveAnnouncerProvider } from "../../../src/renderer/src/console/primitives/index.js";
import { advanceScenarioUntil } from "../../../src/renderer/src/console/repos/scenario-clock.test-support.js";
import { BindWorkspaceDialog } from "../../../src/renderer/src/console/repos/mounts/bind/BindWorkspaceDialog.js";
import { SessionStore } from "../../../src/renderer/src/console/store/index.js";

/** The resolved root the dialog shows above its directory field. Displayed, never joined. */
const MOUNT_ROOT = "/Users/dev/code/ai-sidekicks";

/** The mode a plain directory admits, and the three it does not. */
const EXCLUDED_MODE = "worktree";

/** Mount one bind dialog over the repos scenario, and open it the way a person does. */
async function openBindDialog(repoMountId: string): Promise<{
  readonly container: HTMLElement;
  readonly bridge: ReturnType<typeof createFixtureBridge>;
}> {
  const bridge = createFixtureBridge({ scenario: REPOS_SCENARIO });
  const { container } = await renderSettled(
    <LiveAnnouncerProvider>
      <BindWorkspaceDialog
        bridge={bridge}
        repoMountId={repoMountId}
        canonicalRoot={MOUNT_ROOT}
        sessionStore={new SessionStore({ sessionId: REPOS_SCENARIO.sessionId })}
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
    const { container } = await openBindDialog(GIT_MOUNT_ID);
    const portalled = document.querySelector(".meridian-bind__dialog");
    expect(portalled).not.toBeNull();
    // The claim, and the half a unit engine cannot make: the popup is in the document
    // and is NOT under the card. A dialog rendered inline would satisfy the first and
    // fail here, which is the regression this case exists for.
    expect(container.querySelector(".meridian-bind__dialog")).toBeNull();
  });

  it("moves the focus ring into the popup rather than leaving it on the trigger", async () => {
    const { container } = await openBindDialog(GIT_MOUNT_ID);
    const popup = document.querySelector(".meridian-bind__dialog");
    expect(popup?.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(container.querySelector(".meridian-bind__trigger"));
  });
});

describe("browser — an excluded execution mode cannot be reached", () => {
  it("renders the excluded mode with its reason and refuses the focus", async () => {
    const { bridge } = await openBindDialog(PLAIN_MOUNT_ID);
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
    expect(row.closest(".meridian-bind__mode")?.textContent).toContain("not a git repository");

    const before = document.activeElement;
    row.focus();
    // Chromium refuses to focus a disabled control. This is the assertion happy-dom
    // would pass against a picker that shipped these rows enabled.
    expect(document.activeElement).toBe(before);
    expect(row.checked).toBe(false);
  });

  it("negative control: an admitted mode on the same picker does take the focus", async () => {
    const { bridge } = await openBindDialog(PLAIN_MOUNT_ID);
    let admitted: HTMLInputElement | null = null;
    await advanceScenarioUntil(bridge, () => {
      admitted = document.querySelector<HTMLInputElement>(
        '.meridian-bind__modes input[value="read-only"]',
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
