// The mount card: two axes, two paths, and one control the renderer must not have.
//
// Three negative controls carry `MountCard.tsx`'s three hardest claims: the resolved root
// is never shortened in the STRING, the two status axes are never one chip, and no detach
// control exists anywhere on the surface.

import { fireEvent, render, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { LiveAnnouncerProvider } from "@renderer/console/primitives/index.js";
import { SessionStore } from "@renderer/store/session/session-store.js";
import { bridgeOnClock, scriptedRepoOperations } from "../../repo-operations.test-support.js";
import { MountCard } from "./MountCard.js";
import type { RepoWorkspaceRow } from "../repo-mounts-model.js";
import { CANONICAL_ROOT, ENTERED_PATH, mount, workspaceRow } from "../repo-mounts.test-support.js";

/**
 * The card's own state sentence. Each workspace's prepare form repeats a held reason
 * inside its collapsed disclosure, so a whole-tree text query would find it twice.
 */
function withheldLine(container: HTMLElement): string | null {
  return container.querySelector(".meridian-mount-card__withheld")?.textContent ?? null;
}

const WORKSPACE: RepoWorkspaceRow = workspaceRow();

function renderCard(
  overrides: Partial<React.ComponentProps<typeof MountCard>> = {},
): ReturnType<typeof render> {
  return render(
    // The announcer is the card's environment rather than its dependency: an act on the
    // card announces its settlement, and `useAnnounce` throws outside the provider on
    // purpose — a component speaking into nothing is invisible to everyone who can see
    // the screen.
    <LiveAnnouncerProvider>
      <MountCard
        mount={mount()}
        workspaces={[WORKSPACE]}
        capabilitiesByWorkspaceId={{}}
        pendingModeByWorkspaceId={{}}
        bridge={bridgeOnClock()}
        operations={scriptedRepoOperations()}
        sessionStore={new SessionStore({ sessionId: "session-repos" })}
        onCopyCanonicalRoot={() => undefined}
        onSelectExecutionMode={() => undefined}
        onRequestRead={() => undefined}
        onOpenDiff={() => undefined}
        {...overrides}
      />
    </LiveAnnouncerProvider>,
  );
}

/**
 * The card's head, which is where the resolved root lives.
 *
 * Scoped rather than document-wide: a workspace legitimately roots AT the mount's
 * canonical root, so the same string appears on the card and on the row beneath it, and
 * a document-wide query would fail on a coincidence rather than on the claim.
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
    // Truncation is the stylesheet's, at the measure; the value in the DOM is the
    // whole root. A card that abbreviated the home directory or kept the basename
    // would make two different roots render identically, which is the one thing the card
    // says the renderer must never be the reason for.
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
      mount: mount({ health: { status: "unreachable", checkedAt: "2026-01-01T09:05:01.000Z" } }),
    });
    expect(container.querySelector(".meridian-mount-card--withheld")).not.toBeNull();
    expect(withheldLine(container)).toMatch(/could not be probed/u);
    expect(container.querySelector("fieldset")).toBeNull();
  });

  it("negative control: a detached mount does not read as an unreachable one", () => {
    const { container } = renderCard({ mount: mount({ state: "detached" }) });
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
    // The desktop renderer has no detach surface and no force option on a refused
    // detach. This case fails the moment either becomes a control.
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
    // The one verdict that carries a control, and only that one: `unreachable` may
    // resolve on its own, so offering a re-attach there would push a person into
    // minting a second mount for a path that is about to answer again.
    const { getByLabelText } = renderCard({
      mount: mount({
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
      mount: mount({ health: { status: "unreachable", checkedAt: "2026-01-01T00:00:00Z" } }),
    });
    expect(queryByText("Re-attach this path")).toBeNull();
  });

  it("says the mount is not repaired, and that a new row is minted", () => {
    const { container } = renderCard({
      mount: mount({
        health: { status: "identity_mismatch", checkedAt: "2026-01-01T00:00:00Z" },
      }),
    });
    // The card states the consequence before the confirm does, because a user
    // reads the card before they press anything.
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
    // The card already carries the reason on its withheld line; a control the daemon
    // would refuse anyway would be a second, worse statement of the same fact.
    const { queryByText } = renderCard({
      mount: mount({ health: { status: "unreachable", checkedAt: "2026-01-01T00:00:00Z" } }),
    });
    expect(queryByText("Bind a workspace")).toBeNull();
  });

  it("negative control: a detached mount offers no bind", () => {
    const { queryByText } = renderCard({ mount: mount({ state: "detached" }) });
    expect(queryByText("Bind a workspace")).toBeNull();
  });

  it("negative control: a drifted mount offers the re-attach and no bind", () => {
    // The two controls are mutually exclusive by construction: `bindControlPosture`
    // withholds on any non-healthy verdict, and the re-attach draws on exactly one.
    const { getByLabelText, queryByText } = renderCard({
      mount: mount({
        health: { status: "identity_mismatch", checkedAt: "2026-01-01T00:00:00Z" },
      }),
    });
    expect(getByLabelText(`Re-attach ${ENTERED_PATH}`)).toBeDefined();
    expect(queryByText("Bind a workspace")).toBeNull();
  });
});
