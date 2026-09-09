// What a stopped supervisor does to the repo mount acts, and what it leaves alone.
//
// THE SIX ACTS THIS FAMILY OFFERS EACH REACH A METHOD THE BLOCK CLOSES — `repo.attach`
// for the attach dialog and for the re-attach beside a drifted mount,
// `repo.workspaceBind` for the bind dialog, `repo.executionModeSelect` for the mode
// picker, `repo.executionRootPrepare` / `repo.ephemeralClonePrepare` for the root
// preparation, and `repo.worktreeRetire` / `repo.ephemeralCloneDispose` for the
// disposal — so under an outage none of them can land. `callDaemon` already refuses
// every one at the door and each controller renders the refusal, which is what makes a
// press harmless. This suite is about the half a person sees BEFORE the press: for a
// whole round these controls rendered enabled through an outage, so the affordance said
// the act was available while the door had already decided it was not.
//
// CLOSED MEANS `aria-disabled` PLUS A SENTENCE ON SCREEN, the shape `ControlButton.tsx`
// and `palette/overlay/PaletteResultList.tsx` settled on: the control keeps its place in
// the tab order and the reason is text a reader is taken to, rather than a `title` that
// is reachable by hover alone. The one exception is the mode picker, whose radios sit in
// a `fieldset` — disabling the group is what actually stops a radio taking a press, so
// there the sentence beside it is the whole of the affordance fix.
//
// THE SENTENCE IS READ OFF THE STORE AND NEVER RETYPED. `currentShellMutationBlock` is
// what the door refuses with and what the frame's banner renders, so a case that typed
// the words itself would pass against a control saying something else.
//
// THE DIALOG SURFACES ARE PORTALLED, so the two confirm buttons are read off `document`
// while the triggers and the card-level sentences are read off the render container.

import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { WorkspaceExecutionModeCapabilitiesReadResponse } from "@ai-sidekicks/contracts";

import { createFixtureBridge, type ConsoleBridge } from "../../bridge/index.js";
import { REPOS_SCENARIO } from "../../bridge/scenarios/repos.js";
import { LiveAnnouncerProvider } from "../../primitives/index.js";
import { currentShellMutationBlock, SessionStore, type FrameStore } from "../../store/index.js";
import { quietShell, stoppedShell } from "../../store/shell-condition.test-support.js";
import { AttachRepositoryDialog } from "./attach/AttachRepositoryDialog.js";
import { ReattachControl } from "./attach/ReattachControl.js";
import { BindWorkspaceDialog } from "./bind/BindWorkspaceDialog.js";
import { ExecutionModePicker } from "./ExecutionModePicker.js";
import { workspaceControlPosture, type WorkspaceControlPosture } from "./mount-health.js";
import { GIT_MOUNT_ID, GIT_WORKSPACE_ID } from "../../bridge/scenarios/repos/repos-fixture-data.js";
import { CANONICAL_ROOT } from "./repo-mounts.test-support.js";
import { PrepareExecutionRoot } from "./roots/PrepareExecutionRoot.js";
import { RootDisposalConfirmation } from "./roots/RootDisposalConfirmation.js";

/** What the mount admits, in the reply's own shape. Any live group serves these cases. */
const CAPABILITIES: WorkspaceExecutionModeCapabilitiesReadResponse = {
  availableModes: ["read-only", "worktree"],
  defaultMode: "worktree",
};

/** A canonical UUID, so the disposal call is a request the binding would send. */
const WORKTREE_ID = "019b79ee-0280-740e-8110-d1a4c1150091";

/** The path a drifted mount was attached at, and the node that holds it. */
const LOCAL_PATH = "/Users/dev/code/ai-sidekicks";
const NODE_ID = "019b79ee-0280-740e-8110-d1a4c1150092";

/** The posture a healthy mount with nothing on the wire hands its workspace controls. */
const CONTROLS_LIVE: WorkspaceControlPosture = workspaceControlPosture(
  { offered: true },
  undefined,
);

/** The sentence the block itself carries, read off the store rather than retyped. */
function blockSentence(frameStore: FrameStore): string {
  const block = currentShellMutationBlock(frameStore);
  if (block === undefined) {
    throw new Error("the stopped shell produced no block to read a sentence off");
  }
  return block.detail;
}

function bridge(): ConsoleBridge {
  return createFixtureBridge({ scenario: REPOS_SCENARIO });
}

function sessionStore(): SessionStore {
  return new SessionStore({ sessionId: REPOS_SCENARIO.sessionId });
}

/** One element by class, off whichever root the surface renders into. */
function elementIn(root: ParentNode, selector: string): Element {
  const found = root.querySelector(selector);
  if (found === null) {
    throw new Error(`nothing rendered for ${selector}`);
  }
  return found;
}

/** Whether a control is closed, in the one spelling this console uses for it. */
function isClosed(root: ParentNode, selector: string): boolean {
  return elementIn(root, selector).getAttribute("aria-disabled") === "true";
}

/** The text a surface rendered at `selector`, or `undefined` where it rendered none. */
function sentenceIn(root: ParentNode, selector: string): string | undefined {
  return root.querySelector(selector)?.textContent ?? undefined;
}

function renderAttachDialog(frameStore: FrameStore): HTMLElement {
  const { container } = render(
    <LiveAnnouncerProvider>
      <AttachRepositoryDialog
        bridge={bridge()}
        sessionStore={sessionStore()}
        frameStore={frameStore}
        onAttached={() => undefined}
      />
    </LiveAnnouncerProvider>,
  );
  fireEvent.click(elementIn(container, ".meridian-repo-attach__trigger"));
  return container;
}

function renderBindDialog(frameStore: FrameStore): HTMLElement {
  const { container } = render(
    <LiveAnnouncerProvider>
      <BindWorkspaceDialog
        bridge={bridge()}
        repoMountId={GIT_MOUNT_ID}
        canonicalRoot={CANONICAL_ROOT}
        sessionStore={sessionStore()}
        frameStore={frameStore}
        onBound={() => undefined}
      />
    </LiveAnnouncerProvider>,
  );
  fireEvent.click(elementIn(container, ".meridian-bind__trigger"));
  return container;
}

function renderReattach(frameStore: FrameStore): HTMLElement {
  const { container } = render(
    <ReattachControl
      bridge={bridge()}
      sessionStore={sessionStore()}
      frameStore={frameStore}
      localPath={LOCAL_PATH}
      nodeId={NODE_ID}
      onAttached={() => undefined}
    />,
  );
  return container;
}

function renderDisposal(frameStore: FrameStore): HTMLElement {
  const { container } = render(
    <RootDisposalConfirmation
      bridge={bridge()}
      kind="worktree"
      rootId={WORKTREE_ID}
      frameStore={frameStore}
      onSettled={() => undefined}
    />,
  );
  return container;
}

function renderModePicker(frameStore: FrameStore): HTMLElement {
  const { container } = render(
    <ExecutionModePicker
      workspaceId={GIT_WORKSPACE_ID}
      currentMode="read-only"
      capabilities={CAPABILITIES}
      refusal={undefined}
      refusalMode={undefined}
      pendingMode={undefined}
      posture={CONTROLS_LIVE}
      frameStore={frameStore}
      onSelect={() => undefined}
    />,
  );
  return container;
}

function renderPrepareRoot(frameStore: FrameStore): HTMLElement {
  const { container } = render(
    <PrepareExecutionRoot
      bridge={bridge()}
      workspaceId={GIT_WORKSPACE_ID}
      repoMountId={GIT_MOUNT_ID}
      executionMode="worktree"
      sessionStore={sessionStore()}
      posture={CONTROLS_LIVE}
      frameStore={frameStore}
      onPrepared={() => undefined}
    />,
  );
  return container;
}

describe("the mount acts under a stopped supervisor", () => {
  it("closes the attach confirm and says why", () => {
    const frameStore = stoppedShell();

    renderAttachDialog(frameStore);

    expect(isClosed(document, ".meridian-repo-attach__confirm")).toBe(true);
    expect(sentenceIn(document, ".meridian-repo-attach__held")).toBe(blockSentence(frameStore));
  });

  it("closes the bind confirm and says why", () => {
    const frameStore = stoppedShell();

    renderBindDialog(frameStore);

    expect(isClosed(document, ".meridian-bind__confirm")).toBe(true);
    expect(sentenceIn(document, ".meridian-bind__held")).toBe(blockSentence(frameStore));
  });

  it("closes the re-attach trigger before the confirmation is even opened", () => {
    const frameStore = stoppedShell();

    const container = renderReattach(frameStore);

    // ON THE CARD AND NOT INSIDE THE POPUP. Confirming under a block reaches the door
    // and refuses with this same code, but by then a person has consented to a new
    // mount that was never going to be minted.
    expect(isClosed(container, ".meridian-reattach__trigger")).toBe(true);
    expect(sentenceIn(container, ".meridian-reattach__closed")).toBe(blockSentence(frameStore));
  });

  it("closes the disposal trigger, which is the strongest act on this screen", () => {
    const frameStore = stoppedShell();

    const container = renderDisposal(frameStore);

    expect(isClosed(container, ".meridian-root-disposal__trigger")).toBe(true);
    expect(sentenceIn(container, ".meridian-root-disposal__closed")).toBe(
      blockSentence(frameStore),
    );
  });

  it("closes the mode picker's group and says what is holding it", () => {
    const frameStore = stoppedShell();

    const container = renderModePicker(frameStore);

    // A `fieldset` and not a button: disabling the group is what stops a radio taking
    // a press, and the browser paints no reason for it — so the sentence is the fix.
    const group = elementIn(container, ".meridian-mode-picker__group");
    expect(group).toBeInstanceOf(HTMLFieldSetElement);
    expect((group as HTMLFieldSetElement).disabled).toBe(true);
    expect(sentenceIn(container, ".meridian-mode-picker__held")).toBe(blockSentence(frameStore));
  });

  it("holds the root preparation on the same sentence the mount's own hold uses", () => {
    const frameStore = stoppedShell();

    const container = renderPrepareRoot(frameStore);

    // THE BRANCH FIELD AND NOT THE CONFIRM, deliberately. The confirm is closed by an
    // unfilled form whatever the shell says, so asserting on it would pass against a
    // control that reads no block at all; the field is disabled by the hold and by
    // nothing else, which makes this case about the hold.
    const branch = elementIn(container, ".meridian-prepare-root__branch-input");
    expect((branch as HTMLInputElement).disabled).toBe(true);
    expect(sentenceIn(container, ".meridian-prepare-root__held")).toBe(blockSentence(frameStore));
  });
});

describe("negative control: a supervisor that has reported nothing closes none of them", () => {
  it("leaves every act open and renders no closing sentence", () => {
    renderAttachDialog(quietShell());
    expect(isClosed(document, ".meridian-repo-attach__confirm")).toBe(false);
    expect(sentenceIn(document, ".meridian-repo-attach__held")).toBeUndefined();

    const reattach = renderReattach(quietShell());
    expect(isClosed(reattach, ".meridian-reattach__trigger")).toBe(false);
    expect(sentenceIn(reattach, ".meridian-reattach__closed")).toBeUndefined();

    const disposal = renderDisposal(quietShell());
    expect(isClosed(disposal, ".meridian-root-disposal__trigger")).toBe(false);
    expect(sentenceIn(disposal, ".meridian-root-disposal__closed")).toBeUndefined();

    const picker = renderModePicker(quietShell());
    expect(
      (elementIn(picker, ".meridian-mode-picker__group") as HTMLFieldSetElement).disabled,
    ).toBe(false);
    expect(sentenceIn(picker, ".meridian-mode-picker__held")).toBeUndefined();

    const prepare = renderPrepareRoot(quietShell());
    expect(
      (elementIn(prepare, ".meridian-prepare-root__branch-input") as HTMLInputElement).disabled,
    ).toBe(false);
    expect(sentenceIn(prepare, ".meridian-prepare-root__held")).toBeUndefined();
  });

  it("closes the bind confirm for the FORM and not for the shell, with the form's own words", () => {
    // The half that keeps the six cases above honest: a confirm can be closed for a
    // reason that is not an outage, and when it is, the sentence is the form's rather
    // than the shell's — so a control asserting the wrong cause fails here.
    renderBindDialog(quietShell());

    expect(sentenceIn(document, ".meridian-bind__held")).toBeUndefined();
    expect(sentenceIn(document, ".meridian-bind__blocked")).not.toBeUndefined();
  });
});
