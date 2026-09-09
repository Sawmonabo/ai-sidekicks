// The bind dialog, driven against a mount whose answer changes under it.
//
// WHAT THE MODEL SUITE CANNOT SAY. `bind-model.test.ts` proves the resolution; this file
// proves the dialog HANDS IT what the mount admits, on every open rather than once. Both
// defects below survived a green model suite because neither was in the model: the first
// was a pre-fill held in a ref that outlived the form it was taken about, and the second
// was a picker and a button reading two different answers to one question.
//
// THE CAPABILITIES ARE SERVED BY AN ARM THIS SUITE OWNS, through `withDaemonCall` over
// the real fixture bridge, because both cases turn on the read answering DIFFERENTLY the
// second time. Every other seam stays the fixture's, so a dialog that stopped reaching
// the daemon door would fail here rather than pass against a stub.

import { act, fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { WorkspaceExecutionModeCapabilitiesReadResponse } from "@ai-sidekicks/contracts";

import { withDaemonCall } from "../../../bridge/fixture/call-plane/bridge.test-support.js";
import { createFixtureBridge, type ConsoleBridge } from "../../../bridge/index.js";
import { REPOS_SCENARIO } from "../../../bridge/scenarios/repos.js";
import { LiveAnnouncerProvider } from "../../../primitives/index.js";
import { SessionStore } from "../../../store/index.js";
import { eventOfKind } from "../../../store/session-event.test-support.js";
import { advanceScenarioUntil } from "../../../bridge/scenario-runtime/scenario-clock.test-support.js";
import { BindWorkspaceDialog } from "./BindWorkspaceDialog.js";
import { quietShell } from "../../../store/shell-condition.test-support.js";

/** The read this suite answers for. Every other method stays the fixture's. */
const CAPABILITIES_METHOD = "repo.executionModeCapabilitiesRead";

/** The mount a workspace binds on, and the root shown above the directory field. */
const MOUNT_ID = "019b79ee-0280-7ea1-8110-e5e0d1150044";
const MOUNT_ROOT = "/Users/dev/code/ai-sidekicks";

/** A frame that owes this family's readings a fresh answer. */
const REPO_FRAME_KIND = "workspace.stale";

/** A git mount: every mode admitted, `worktree` the daemon's own default. */
const EVERY_MODE: WorkspaceExecutionModeCapabilitiesReadResponse = {
  availableModes: ["read-only", "branch", "worktree", "ephemeral clone"],
  defaultMode: "worktree",
};

/** The same mount after `branch` stops being admitted, with the mount's own reason. */
const BRANCH_WITHDRAWN: WorkspaceExecutionModeCapabilitiesReadResponse = {
  availableModes: ["read-only", "worktree", "ephemeral clone"],
  defaultMode: "worktree",
  restrictions: { branch: "the checkout is on a detached HEAD" },
};

/** A different narrowing that leaves `branch` alone, for the negative controls. */
const CLONE_WITHDRAWN: WorkspaceExecutionModeCapabilitiesReadResponse = {
  availableModes: ["read-only", "branch", "worktree"],
  defaultMode: "worktree",
  restrictions: { "ephemeral clone": "this node has no scratch volume" },
};

/** A reply that disagrees with itself, which is the one way a mount serves no default. */
const NO_DEFAULT: WorkspaceExecutionModeCapabilitiesReadResponse = {
  availableModes: ["read-only", "branch"],
  defaultMode: "worktree",
};

/**
 * A bridge whose pre-bind read this suite decides, and can decide again.
 *
 * The answer is chosen at CALL time rather than closed over, which is what lets one
 * case serve two different replies to the same dialog — the shape every case here needs
 * and the one a value captured at construction cannot have.
 */
class CapabilitiesUnderTest {
  #capabilities: WorkspaceExecutionModeCapabilitiesReadResponse;
  readonly bridge: ConsoleBridge;

  public constructor(capabilities: WorkspaceExecutionModeCapabilitiesReadResponse) {
    this.#capabilities = capabilities;
    const fixture = createFixtureBridge({ scenario: REPOS_SCENARIO });
    this.bridge = withDaemonCall(fixture, async (call, passThrough) =>
      call.method === CAPABILITIES_METHOD
        ? await Promise.resolve(this.#capabilities)
        : await passThrough(),
    ).bridge;
  }

  /** What the next read answers with. The refresh itself is a frame, below. */
  public serve(capabilities: WorkspaceExecutionModeCapabilitiesReadResponse): void {
    this.#capabilities = capabilities;
  }
}

/** A store with a base state, which is what makes a later frame a frame and not history. */
function initialisedStore(): SessionStore {
  const sessionStore = new SessionStore({ sessionId: REPOS_SCENARIO.sessionId });
  sessionStore.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
  return sessionStore;
}

/** Everything one case drives: the read it answers, the store it refreshes through. */
interface OpenDialog {
  readonly capabilities: CapabilitiesUnderTest;
  readonly sessionStore: SessionStore;
  readonly container: HTMLElement;
}

/** The picker's rows, off the document because the popup is portalled out of the card. */
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
  const sessionStore = initialisedStore();
  const { container } = render(
    <LiveAnnouncerProvider>
      <BindWorkspaceDialog
        bridge={served.bridge}
        repoMountId={MOUNT_ID}
        canonicalRoot={MOUNT_ROOT}
        sessionStore={sessionStore}
        frameStore={quietShell()}
        onBound={() => undefined}
      />
    </LiveAnnouncerProvider>,
  );
  pressTrigger(container);
  await advanceScenarioUntil(served.bridge, () => {
    expect(modeRadios().length).toBeGreaterThan(0);
  });
  return { capabilities: served, sessionStore, container };
}

/**
 * Refresh what the mount admits: a watched frame, then the debounce.
 *
 * WAITS ON THE ROW THE NEW ANSWER CHANGES, and not on rows existing: the picker is
 * already drawing the previous answer, so a looser wait would return before the second
 * read landed and every assertion after it would be about the answer being replaced.
 */
async function refreshCapabilitiesTo(
  open: OpenDialog,
  capabilities: WorkspaceExecutionModeCapabilitiesReadResponse,
  withdrawnMode: string,
  sequence: number,
): Promise<void> {
  open.capabilities.serve(capabilities);
  open.sessionStore.applyBatch([eventOfKind(REPOS_SCENARIO.sessionId, REPO_FRAME_KIND, sequence)]);
  await advanceScenarioUntil(open.capabilities.bridge, () => {
    expect(radioFor(withdrawnMode).disabled).toBe(true);
  });
}

describe("the bind dialog — the mount's own default survives a close", () => {
  it("applies the default on the first open", async () => {
    await openDialog(EVERY_MODE);
    expect(radioFor("worktree").checked).toBe(true);
    expect(bindButton().disabled).toBe(false);
  });

  it("applies it again when the same mount is reopened", async () => {
    // The state this fix was written for. The pre-fill was held in a ref keyed on the
    // mount, and closing reset the form without resetting the ref — so on a reopen the
    // read had not changed, the effect declined to run again, and the dialog offered a
    // picker with nothing chosen behind a control that would not send.
    const open = await openDialog(EVERY_MODE);
    act(() => {
      document.querySelector<HTMLButtonElement>(".meridian-bind__cancel")?.click();
    });
    expect(document.querySelector(".meridian-bind__dialog")).toBeNull();

    pressTrigger(open.container);

    expect(radioFor("worktree").checked).toBe(true);
    expect(bindButton().disabled).toBe(false);
  });

  it("negative control: a reply that names a default it does not offer chooses nothing", async () => {
    // Without this, the two cases above would pass against a dialog that pre-picked
    // whatever came first — a mode of the console's own choosing, which is the one thing
    // `repo.workspaceBind`'s omitted-versus-chosen distinction exists to prevent.
    await openDialog(NO_DEFAULT);
    expect(modeRadios().every((radio) => !radio.checked)).toBe(true);
    expect(bindButton().disabled).toBe(true);
    expect(blockedSentence()).toContain("execution mode");
  });
});

describe("the bind dialog — a capabilities refresh that withdraws the chosen mode", () => {
  it("clears the selection and shuts the control rather than sending an excluded mode", async () => {
    const open = await openDialog(EVERY_MODE);
    fireEvent.click(radioFor("branch"));
    expect(radioFor("branch").checked).toBe(true);
    expect(bindButton().disabled).toBe(false);

    await refreshCapabilitiesTo(open, BRANCH_WITHDRAWN, "branch", 1);

    // The defect: the row went disabled with the mount's own reason beside it while the
    // form-only verdict stayed sendable, so Bind would have sent exactly that mode.
    expect(modeRadios().every((radio) => !radio.checked)).toBe(true);
    expect(bindButton().disabled).toBe(true);
    expect(blockedSentence()).toContain("no longer one this mount admits");
  });

  it("negative control: a refresh that keeps the chosen mode leaves the control open", async () => {
    // Without this, the case above would pass against a dialog that shut its control on
    // every refresh — which would make the read's own re-run the thing that broke it.
    const open = await openDialog(EVERY_MODE);
    fireEvent.click(radioFor("branch"));

    await refreshCapabilitiesTo(open, CLONE_WITHDRAWN, "ephemeral clone", 1);

    expect(radioFor("branch").checked).toBe(true);
    expect(bindButton().disabled).toBe(false);
  });
});
