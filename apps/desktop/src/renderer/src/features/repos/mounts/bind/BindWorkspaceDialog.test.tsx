// The bind dialog, driven against a mount whose answer changes under it. `bind-form.test.ts`
// proves the resolution; this proves the dialog hands it what the mount admits on every open:
// a pre-fill must not outlive its form, and the picker and the button must read one answer.
// Capabilities come from a call this suite owns, so a case can serve a different answer the
// second time.

import { act, fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { WorkspaceExecutionModeCapabilitiesReadResponse } from "@ai-sidekicks/contracts/workspace";
import { LiveAnnouncerProvider } from "@renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { SessionStore } from "@renderer/store/session/session-store.js";
import { eventOfKind } from "@test/helpers/session/events.js";
import { initializedStore } from "@test/helpers/session/store/fixtures.js";
import { advanceScenarioUntil } from "@test/helpers/scenario-manual-clock.js";
import { bridgeOnClock, type BridgeOnClock } from "@test/helpers/fixture/bridge.js";
import { bridgeWrapper } from "@test/helpers/app/frame-fixtures.js";
import { scriptedRepoOperations } from "../../repo-operations.test-support.js";
import type { RepoOperations } from "../../repo-operations.js";
import { BindWorkspaceDialog } from "./BindWorkspaceDialog.js";

const SESSION_ID = "session-repos";

/** The mount a workspace binds on, and the root shown above the directory field. */
const MOUNT_ID = "019b79ee-0280-7ea1-8110-e5e0d1150044";
const MOUNT_ROOT = "/Users/dev/code/ai-sidekicks";

/** A frame that owes the repos feature's readings a fresh answer. */
const REPO_FRAME_KIND = "workspace.stale";

/** A mount admitting both modes, `provisioned-worktree` the daemon's own default. */
const EVERY_MODE: WorkspaceExecutionModeCapabilitiesReadResponse = {
  availableModes: ["bound-root", "provisioned-worktree"],
  defaultMode: "provisioned-worktree",
};

/** The same mount after `bound-root` stops being admitted, with the mount's own reason. */
const BOUND_ROOT_WITHDRAWN: WorkspaceExecutionModeCapabilitiesReadResponse = {
  availableModes: ["provisioned-worktree"],
  defaultMode: "provisioned-worktree",
  restrictions: { "bound-root": "the checkout is on a detached HEAD" },
};

/**
 * A pre-bind read this suite decides, and can decide again. The answer is chosen at call time
 * rather than closed over, so one case can serve two different replies to the same dialog.
 */
class CapabilitiesUnderTest {
  #capabilities: WorkspaceExecutionModeCapabilitiesReadResponse;
  /** The bridge the dialog is handed, the engine playing it, and its window's clock. */
  readonly fixture: BridgeOnClock = bridgeOnClock("repos");
  readonly operations: RepoOperations;

  public constructor(capabilities: WorkspaceExecutionModeCapabilitiesReadResponse) {
    this.#capabilities = capabilities;
    this.operations = scriptedRepoOperations({
      readMountExecutionModes: () => Promise.resolve(this.#capabilities),
    });
  }

  /** What the next read answers with. The refresh itself is a frame, below. */
  public serve(capabilities: WorkspaceExecutionModeCapabilitiesReadResponse): void {
    this.#capabilities = capabilities;
  }
}

/** Everything one case drives: the read it answers, the store it refreshes through. */
interface OpenDialog {
  readonly capabilities: CapabilitiesUnderTest;
  readonly sessionStore: SessionStore;
  readonly container: HTMLElement;
}

/** The picker's rows, off the document because the popup is portaled out of the card. */
function modeRadios(): readonly HTMLInputElement[] {
  return [...document.querySelectorAll<HTMLInputElement>(".meridian-bind__modes input")];
}

function radioFor(mode: string): HTMLInputElement {
  const radio = modeRadios().find((candidate) => candidate.value === mode);
  if (radio === undefined) {
    throw new Error(`the picker offers no row for ${mode}`);
  }
  return radio;
}

function bindButton(): HTMLButtonElement {
  const control = document.querySelector<HTMLButtonElement>(".meridian-bind__confirm");
  if (control === null) {
    throw new Error("the dialog rendered no Bind control");
  }
  return control;
}

/** What the dialog says under a shut control, or nothing where it says nothing. */
function blockedSentence(): string | undefined {
  return document.querySelector(".meridian-bind__blocked")?.textContent ?? undefined;
}

function pressTrigger(container: HTMLElement): void {
  act(() => {
    container.querySelector<HTMLButtonElement>(".meridian-bind__trigger")?.click();
  });
}

/** Mount the dialog, open it the way a person does, and wait for the picker. */
async function openDialog(
  capabilities: WorkspaceExecutionModeCapabilitiesReadResponse,
): Promise<OpenDialog> {
  const served = new CapabilitiesUnderTest(capabilities);
  const sessionStore = initializedStore(SESSION_ID);
  const { container } = render(
    <LiveAnnouncerProvider>
      <BindWorkspaceDialog
        bridge={served.fixture.bridge}
        operations={served.operations}
        repoMountId={MOUNT_ID}
        canonicalRoot={MOUNT_ROOT}
        sessionStore={sessionStore}
        onBound={() => undefined}
      />
    </LiveAnnouncerProvider>,
    { wrapper: bridgeWrapper(served.fixture.bridge, served.fixture.clock) },
  );
  pressTrigger(container);
  await advanceScenarioUntil(served.fixture.scenarioEngine, () => {
    expect(modeRadios().length).toBeGreaterThan(0);
  });
  return { capabilities: served, sessionStore, container };
}

/**
 * Refresh what the mount admits: a watched frame, then the debounce. Waits on the row the new
 * answer changes, not on rows existing: the picker still draws the previous answer, so a
 * looser wait would return before the second read landed.
 */
async function refreshCapabilitiesTo(
  open: OpenDialog,
  capabilities: WorkspaceExecutionModeCapabilitiesReadResponse,
  withdrawnMode: string,
  sequence: number,
): Promise<void> {
  open.capabilities.serve(capabilities);
  open.sessionStore.applyBatch([eventOfKind(SESSION_ID, REPO_FRAME_KIND, sequence)]);
  await advanceScenarioUntil(open.capabilities.fixture.scenarioEngine, () => {
    expect(radioFor(withdrawnMode).disabled).toBe(true);
  });
}

describe("the bind dialog — the mount's own default survives a close", () => {
  it("applies it again when the same mount is reopened, over the mode picked before", async () => {
    // A pre-fill held in a ref keyed on the mount would survive a close that reset the form:
    // on a reopen the effect declines to run again, leaving a picker with nothing chosen
    // behind a control that will not send. A form that survived the close would instead send
    // the last visit's pick.
    const open = await openDialog(EVERY_MODE);
    fireEvent.click(radioFor("bound-root"));
    act(() => {
      document.querySelector<HTMLButtonElement>(".meridian-bind__cancel")?.click();
    });
    expect(document.querySelector(".meridian-bind__dialog")).toBeNull();

    pressTrigger(open.container);

    expect(radioFor("provisioned-worktree").checked).toBe(true);
    expect(bindButton().disabled).toBe(false);
  });
});

describe("the bind dialog — a capabilities refresh that withdraws the chosen mode", () => {
  it("clears the selection and shuts the control rather than send an excluded mode", async () => {
    const open = await openDialog(EVERY_MODE);
    fireEvent.click(radioFor("bound-root"));
    expect(radioFor("bound-root").checked).toBe(true);
    expect(bindButton().disabled).toBe(false);

    await refreshCapabilitiesTo(open, BOUND_ROOT_WITHDRAWN, "bound-root", 1);

    // The row went disabled with the mount's reason beside it while the form-only verdict
    // stayed sendable, so Bind would have sent exactly that mode.
    expect(modeRadios().every((radio) => !radio.checked)).toBe(true);
    expect(bindButton().disabled).toBe(true);
    expect(blockedSentence()).toContain("no longer one this mount admits");
  });
});
