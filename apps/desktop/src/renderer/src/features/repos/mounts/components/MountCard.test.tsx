// The mount card: the resolved root in its head, an unreachable mount withholding its bind
// controls, and a drifted one offering the re-attach.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { SessionStore } from "#renderer/store/session/store.js";
import { bridgeOnClock } from "#test/helpers/fixture/bridge.js";
import { bridgeWrapper } from "#test/helpers/app/frame-fixtures.js";
import { scriptedRepoOperations } from "../../operations.test-support.js";
import { MountCard } from "./MountCard.js";
import type { RepoWorkspaceRow } from "../reading.js";
import {
  CANONICAL_ROOT,
  ENTERED_PATH,
  buildMount,
  workspaceRow,
} from "../repo-mounts.test-support.js";
import { HOVER_LABEL_TEXT_ATTRIBUTE } from "#renderer/components/HoverLabel/HoverLabel.js";

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
        bridge={bridge}
        operations={scriptedRepoOperations()}
        sessionStore={new SessionStore({ sessionId: "session-repos" })}
        onCopyCanonicalRoot={() => undefined}
        onRequestRead={() => undefined}
        onOpenDiff={() => undefined}
        {...overrides}
      />
    </LiveAnnouncerProvider>,
    { wrapper: bridgeWrapper(bridge, clock) },
  );
}

describe("MountCard — the resolved root", () => {
  it("renders the root the attach resolved, whole, in the card's head", () => {
    // Scoped to the head because a workspace can root at the mount's canonical root, so the
    // same string also appears on the row beneath.
    const { container } = renderCard();
    const head = container.querySelector(".meridian-mount-card__head") as HTMLElement;
    expect(
      head.querySelector(`[${HOVER_LABEL_TEXT_ATTRIBUTE}="${CANONICAL_ROOT}"]`)?.textContent,
    ).toBe(CANONICAL_ROOT);
  });
});

describe("MountCard — an unreachable mount", () => {
  it("puts an unreachable mount in an error posture and withholds its bind controls", () => {
    const { container } = renderCard({
      mount: buildMount({
        health: { status: "unreachable", checkedAt: "2026-01-01T09:05:01.000Z" },
      }),
    });
    expect(container.querySelector(".meridian-mount-card--withheld")).not.toBeNull();
    expect(withheldLine(container)).toMatch(/could not be probed/u);
  });
});

describe("MountCard — the drifted mount and its one control", () => {
  it("offers the re-attach on a mount whose identity no longer matches", () => {
    // `unreachable` may resolve on its own, so a re-attach there would mint a second mount for
    // a path about to answer again.
    const { getByLabelText } = renderCard({
      mount: buildMount({
        health: {
          status: "identity_mismatch",
          isRepository: true,
          checkedAt: "2026-01-01T00:00:00Z",
        },
      }),
    });
    expect(getByLabelText(`Re-attach ${ENTERED_PATH}`)).toBeDefined();
  });

  it("offers no re-attach once the drifted root is no longer a git repository", () => {
    const { queryByLabelText } = renderCard({
      mount: buildMount({
        health: {
          status: "identity_mismatch",
          isRepository: false,
          checkedAt: "2026-01-01T00:00:00Z",
        },
      }),
    });
    expect(queryByLabelText(`Re-attach ${ENTERED_PATH}`)).toBeNull();
  });

  it("offers no re-attach on an unreachable mount, which may answer again", () => {
    const { queryByText } = renderCard({
      mount: buildMount({ health: { status: "unreachable", checkedAt: "2026-01-01T00:00:00Z" } }),
    });
    expect(queryByText("Re-attach this path")).toBeNull();
  });
});
