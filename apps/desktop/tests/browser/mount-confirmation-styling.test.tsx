// The browser tier: a mounts confirmation draws as a dialog, and a mounts form draws its labels and
// inputs. Their trigger, backdrop, popup, labels and inputs take their whole treatment from the
// global sheets beside their own class, so a sheet nothing loads leaves the popup in the page's
// flow under a native button and a field as a bare browser input; only a real engine's cascade
// shows which rules reached the element.

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { installMeridianTokens } from "#renderer/app/token-installation.js";
import { readWorkspaceControlAvailability } from "#renderer/features/repos/mounts/health.js";
import { PrepareExecutionRoot } from "#renderer/features/repos/mounts/execution-roots/prepare/PrepareExecutionRoot.js";
import { RootRemovalConfirmation } from "#renderer/features/repos/mounts/execution-roots/removal/RootRemovalConfirmation.js";
import { preparingDaemon } from "#renderer/features/repos/mounts/repo-mounts.test-support.js";
import { scriptedRepoOperations } from "#renderer/features/repos/repo-operations.test-support.js";
import { SessionStore } from "#renderer/store/session/session-store.js";
import { bridgeWrapper } from "../helpers/app/frame-fixtures.js";
import { bridgeOnClock } from "../helpers/fixture/bridge.js";

const WORKTREE_ID = "019b79ee-0280-740e-8110-d1a4c1150091";

afterEach(() => {
  cleanup();
});

describe("browser — a mounts confirmation wears the shared dialog and button treatments", () => {
  it("lays the backdrop over the window and centers the popup above it", async () => {
    render(
      <RootRemovalConfirmation
        bridge={bridgeOnClock("repos").bridge}
        operations={scriptedRepoOperations()}
        rootId={WORKTREE_ID}
      />,
    );
    const trigger = screen.getByRole("button", { name: `Remove ${WORKTREE_ID}` });
    expect(getComputedStyle(trigger).borderTopStyle).toBe("solid");
    expect(getComputedStyle(trigger).cursor).toBe("pointer");

    await act(async () => {
      trigger.click();
    });

    const popup = await screen.findByRole("alertdialog");
    const backdrop = popup.ownerDocument.querySelector(".meridian-dialog__backdrop");
    expect(backdrop).not.toBeNull();
    expect(getComputedStyle(backdrop as Element).position).toBe("fixed");
    expect(getComputedStyle(popup).position).toBe("fixed");
    const box = popup.getBoundingClientRect();
    expect(Math.abs(box.left + box.width / 2 - window.innerWidth / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.top + box.height / 2 - window.innerHeight / 2)).toBeLessThanOrEqual(1);
  });

  it("draws a mounts form's label as a label and its input with its own edge", () => {
    // The input's edge is drawn from tokens, and a declaration naming an unset token draws none.
    installMeridianTokens(document);
    const { bridge, clock } = bridgeOnClock("repos");
    const { container } = render(
      <PrepareExecutionRoot
        bridge={bridge}
        operations={scriptedRepoOperations(preparingDaemon())}
        workspaceId="workspace-sidekicks"
        repoMountId="mount-sidekicks"
        executionMode="provisioned-worktree"
        sessionStore={new SessionStore({ sessionId: "session-repos" })}
        availability={readWorkspaceControlAvailability({ available: true }, undefined)}
        onPrepared={() => undefined}
      />,
      { wrapper: bridgeWrapper(bridge, clock) },
    );
    const label = container.querySelector(".meridian-form__label");
    const input = container.querySelector(".meridian-form__input");
    expect(label).not.toBeNull();
    expect(input).not.toBeNull();
    expect(getComputedStyle(label as Element).textTransform).toBe("uppercase");
    expect(getComputedStyle(input as Element).borderTopStyle).toBe("solid");
    expect(getComputedStyle(input as Element).borderTopLeftRadius).not.toBe("0px");
  });
});
