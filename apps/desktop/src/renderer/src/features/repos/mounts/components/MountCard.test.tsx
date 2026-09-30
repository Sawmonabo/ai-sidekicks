// The mount card: two axes, two paths, and one control the renderer must not have. The root
// is never shortened in the string, the axes are never one chip, and no detach control exists.

import { fireEvent, render, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { LiveAnnouncerProvider } from "@renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { SessionStore } from "@renderer/store/session/session-store.js";
import { bridgeOnClock } from "@test/helpers/fixture-bridge.js";
import { bridgeWrapper } from "@test/helpers/app-frame-fixtures.js";
import { scriptedRepoOperations } from "../../repo-operations.test-support.js";
import { MountCard } from "./MountCard.js";
import type { RepoWorkspaceRow } from "../repo-mounts-model.js";
import {
  CANONICAL_ROOT,
  ENTERED_PATH,
  buildMount,
  workspaceRow,
} from "../repo-mounts.test-support.js";

/** The card's own state sentence; each prepare form repeats a held reason in its disclosure. */
function withheldLine(container: HTMLElement): string | null {
  return container.querySelector(".meridian-mount-card__withheld")?.textContent ?? null;
}

const WORKSPACE: RepoWorkspaceRow = workspaceRow();

function renderCard(
  overrides: Partial<React.ComponentProps<typeof MountCard>> = {},
): ReturnType<typeof render> {
  const { bridge, clock } = bridgeOnClock("repos");
  return render(
    // An act on the card announces its settlement, and `useAnnounce` throws outside the
    // provider on purpose.
    <LiveAnnouncerProvider>
      <MountCard
        mount={buildMount()}
        workspaces={[WORKSPACE]}
        capabilitiesByWorkspaceId={{}}
        pendingModeByWorkspaceId={{}}
        bridge={bridge}
        operations={scriptedRepoOperations()}
        sessionStore={new SessionStore({ sessionId: "session-repos" })}
        onCopyCanonicalRoot={() => undefined}
        onSelectExecutionMode={() => undefined}
        onRequestRead={() => undefined}
        onOpenDiff={() => undefined}
        {...overrides}
      />
    </LiveAnnouncerProvider>,
    { wrapper: bridgeWrapper(bridge, clock) },
  );
}

/**
 * The card's head, where the resolved root lives. Scoped because a workspace can root at the
 * mount's canonical root, so the same string also appears on the row beneath.
 */
function head(container: HTMLElement): HTMLElement {
  return container.querySelector(".meridian-mount-card__head") as HTMLElement;
}

describe("MountCard — the two paths", () => {
  it("surfaces the resolved root and the entered path as different facts", () => {
    const { container, getByTitle } = renderCard();
    expect(within(head(container)).getByTitle(CANONICAL_ROOT)).toBeDefined();
    expect(getByTitle(ENTERED_PATH)).toBeDefined();
  });

  it("negative control: the resolved root is never shortened in the string", () => {
    // The value in the DOM is the whole root; truncation is the stylesheet's. Shortening it
    // would make two different roots render identically.
    const { container } = renderCard();
    expect(within(head(container)).getByTitle(CANONICAL_ROOT).textContent).toBe(CANONICAL_ROOT);
  });

  it("offers the root as something a person can carry out of the console", () => {
    const onCopyCanonicalRoot = vi.fn();
    const { getByLabelText } = renderCard({ onCopyCanonicalRoot });
    getByLabelText(`Copy the resolved root ${CANONICAL_ROOT}`).click();
    expect(onCopyCanonicalRoot).toHaveBeenCalledWith(CANONICAL_ROOT);
  });
});

describe("MountCard — the two axes", () => {
  it("wears one chip per axis, with the probe instant beside the health one", () => {
    const { container } = renderCard();
    const chips = [...container.querySelectorAll(".meridian-chip__label")].map(
      (chip) => chip.textContent,
    );
    expect(chips).toContain("attached");
    expect(chips).toContain("healthy");
    expect(container.querySelector(".meridian-mount-card__checked-at")?.textContent).toContain(
      "probed",
    );
  });

  it("puts an unreachable mount in an error posture and withholds its bind controls", () => {
    const { container } = renderCard({
      mount: buildMount({
        health: { status: "unreachable", checkedAt: "2026-01-01T09:05:01.000Z" },
      }),
    });
    expect(container.querySelector(".meridian-mount-card--withheld")).not.toBeNull();
    expect(withheldLine(container)).toMatch(/could not be probed/u);
    expect(container.querySelector("fieldset")).toBeNull();
  });

  it("negative control: a detached mount does not read as an unreachable one", () => {
    const { container } = renderCard({ mount: buildMount({ state: "detached" }) });
    expect(withheldLine(container)).toMatch(/mints a new mount/u);
    expect(withheldLine(container)).not.toMatch(/could not be probed/u);
  });
});

describe("MountCard — the way into a change set", () => {
  it("offers the workspace row's own subject, so the pane opens over what the row is", () => {
    const onOpenDiff = vi.fn();
    const { getByLabelText } = renderCard({ onOpenDiff });
    fireEvent.click(getByLabelText(`Open the changes of workspace ${WORKSPACE.id}`));
    expect(onOpenDiff).toHaveBeenCalledWith({ kind: "workspace", id: WORKSPACE.id });
  });
});

describe("MountCard — what the renderer must not offer", () => {
  it("negative control: nothing on the card is a detach control", () => {
    // The desktop renderer has no detach control and no force option on a refused detach.
    const { container } = renderCard();
    for (const element of container.querySelectorAll("button, input, a")) {
      const description = `${element.getAttribute("aria-label") ?? ""} ${element.textContent ?? ""}`;
      expect(description.toLowerCase()).not.toContain("detach");
      expect(description.toLowerCase()).not.toContain("force");
    }
  });
});

describe("MountCard — the drifted mount and its one control", () => {
  it("offers the re-attach on a mount whose identity no longer matches", () => {
    // `unreachable` may resolve on its own, so a re-attach there would mint a second mount for
    // a path about to answer again.
    const { getByLabelText } = renderCard({
      mount: buildMount({
        health: { status: "identity_mismatch", checkedAt: "2026-01-01T00:00:00Z" },
      }),
    });
    expect(getByLabelText(`Re-attach ${ENTERED_PATH}`)).toBeDefined();
  });

  it("negative control: a healthy mount offers no re-attach", () => {
    const { queryByText } = renderCard();
    expect(queryByText("Re-attach this path")).toBeNull();
  });

  it("negative control: an unreachable mount offers no re-attach either", () => {
    const { queryByText } = renderCard({
      mount: buildMount({ health: { status: "unreachable", checkedAt: "2026-01-01T00:00:00Z" } }),
    });
    expect(queryByText("Re-attach this path")).toBeNull();
  });

  it("says the mount is not repaired, and that a new row is minted", () => {
    const { container } = renderCard({
      mount: buildMount({
        health: { status: "identity_mismatch", checkedAt: "2026-01-01T00:00:00Z" },
      }),
    });
    // The card states the consequence before the confirm does.
    expect(withheldLine(container)).toMatch(/mints a new mount/u);
  });
});

describe("MountCard — the bind entry point", () => {
  it("offers a bind on an attached, healthy mount", () => {
    // Attach mints no workspace, so this trigger is where every workspace comes from.
    const { getByText } = renderCard();
    expect(getByText("Bind a workspace")).toBeDefined();
  });

  it("negative control: an unreachable mount offers no bind", () => {
    // The withheld line already carries the reason.
    const { queryByText } = renderCard({
      mount: buildMount({ health: { status: "unreachable", checkedAt: "2026-01-01T00:00:00Z" } }),
    });
    expect(queryByText("Bind a workspace")).toBeNull();
  });

  it("negative control: a detached mount offers no bind", () => {
    const { queryByText } = renderCard({ mount: buildMount({ state: "detached" }) });
    expect(queryByText("Bind a workspace")).toBeNull();
  });

  it("negative control: a drifted mount offers the re-attach and no bind", () => {
    // Mutually exclusive: bind is withheld on any non-healthy verdict, re-attach draws on one.
    const { getByLabelText, queryByText } = renderCard({
      mount: buildMount({
        health: { status: "identity_mismatch", checkedAt: "2026-01-01T00:00:00Z" },
      }),
    });
    expect(getByLabelText(`Re-attach ${ENTERED_PATH}`)).toBeDefined();
    expect(queryByText("Bind a workspace")).toBeNull();
  });
});
