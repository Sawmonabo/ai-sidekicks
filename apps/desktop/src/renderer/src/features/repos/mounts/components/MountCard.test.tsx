// The mount card: an unreachable mount withholds its bind controls, a drifted one offers the
// re-attach, and a healthy one offers the bind.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LiveAnnouncerProvider } from "@renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { SessionStore } from "@renderer/store/session/session-store.js";
import { bridgeOnClock } from "@test/helpers/fixture-bridge.js";
import { bridgeWrapper } from "@test/helpers/app-frame-fixtures.js";
import { scriptedRepoOperations } from "../../repo-operations.test-support.js";
import { MountCard } from "./MountCard.js";
import type { RepoWorkspaceRow } from "../repo-mounts-model.js";
import { ENTERED_PATH, buildMount, workspaceRow } from "../repo-mounts.test-support.js";

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

describe("MountCard — an unreachable mount", () => {
  it("puts an unreachable mount in an error posture and withholds its bind controls", () => {
    const { container, queryByText } = renderCard({
      mount: buildMount({
        health: { status: "unreachable", checkedAt: "2026-01-01T09:05:01.000Z" },
      }),
    });
    expect(container.querySelector(".meridian-mount-card--withheld")).not.toBeNull();
    expect(withheldLine(container)).toMatch(/could not be probed/u);
    expect(queryByText("Bind a workspace")).toBeNull();
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

  it("offers no re-attach on an unreachable mount, which may answer again", () => {
    const { queryByText } = renderCard({
      mount: buildMount({ health: { status: "unreachable", checkedAt: "2026-01-01T00:00:00Z" } }),
    });
    expect(queryByText("Re-attach this path")).toBeNull();
  });
});

describe("MountCard — the bind entry point", () => {
  it("offers a bind on an attached, healthy mount", () => {
    // Attach mints no workspace, so this trigger is where every workspace comes from.
    const { getByText } = renderCard();
    expect(getByText("Bind a workspace")).toBeDefined();
  });
});
