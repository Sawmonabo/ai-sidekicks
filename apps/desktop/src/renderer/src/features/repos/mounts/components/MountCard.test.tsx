// The mount card: the resolved root in its head, and an unreachable mount withholding its bind
// controls.

import { render, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { bridgeOnClock } from "#test/helpers/fixture/bridge.js";
import { bridgeWrapper } from "#test/helpers/app/frame-fixtures.js";
import { OUTSIDE_LIVE_REGIONS } from "#test/helpers/live-region.js";
import { scriptedRepoOperations } from "../../operations.test-support.js";
import { readBindControlAvailability } from "../bind-control-availability.js";
import { MountCard } from "./MountCard.js";
import type { RepoWorkspaceRow } from "../reading.js";
import { CANONICAL_ROOT, buildMount, workspaceRow } from "../repo-mounts.test-support.js";
import { HOVER_LABEL_TEXT_ATTRIBUTE } from "#renderer/components/HoverLabel/HoverLabel.js";

/** The card's own state sentence. */
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

  it("states the held reason once, as the description of each workspace's Prepare", () => {
    const mount = buildMount({
      health: { status: "unreachable", checkedAt: "2026-01-01T09:05:01.000Z" },
    });
    const availability = readBindControlAvailability(mount);
    if (availability.available) {
      throw new Error("an unreachable mount offered its bind controls");
    }
    const reason = availability.unavailableBecause;
    const { container } = renderCard({ mount });
    // The form sits in a collapsed disclosure, so its control is reached with `hidden`.
    const prepare = within(container).getByRole("button", { name: "Prepare", hidden: true });
    const describingLines = (prepare.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((lineId) => container.ownerDocument.getElementById(lineId));

    const drawnReasons = within(container).getAllByText(reason, { ignore: OUTSIDE_LIVE_REGIONS });
    expect(drawnReasons).toHaveLength(1);
    expect(describingLines).toContain(drawnReasons[0]);
  });
});
