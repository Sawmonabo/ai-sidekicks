// The mount card: two axes, two paths, and one control the renderer must not have.
//
// Three negative controls carry `MountCard.tsx`'s three
// hardest claims: the resolved root is never shortened in the STRING, the two status
// axes are never one chip, and no detach control exists anywhere on the surface.

import { render, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  fixtureBridgeWithGrowth,
  growthRefusing,
} from "../../bridge/fixture/fixture-bridge.test-support.js";
import { REPOS_SCENARIO } from "../../bridge/scenarios/repos.js";
import { refuse } from "../../core/index.js";
import { LiveAnnouncerProvider } from "../../primitives/index.js";
import { SessionStore } from "../../store/index.js";
import { MountCard } from "./MountCard.js";
import { NO_WORKSPACE_REFUSALS } from "./repo-mounts-model.js";
import type { RepoWorkspaceRow } from "./repo-mounts-model.js";
import type { WorktreeStatusRecord } from "./worktree-model.js";
import {
  CANONICAL_ROOT,
  ENTERED_PATH,
  mount,
  workspaceRow,
  worktreeRecord,
} from "./repo-mounts.test-support.js";

const WORKSPACE: RepoWorkspaceRow = workspaceRow();

/**
 * A bridge whose gate read refuses, which is what the live bridge does.
 *
 * The refusal is COMPOSED by the port rather than written out beside the case: the
 * hand-written twin this replaces carried four members where the port's own refusal
 * carries seven, so a case comparing a rendered refusal against it was comparing
 * against a value the port could never produce, and its sentence was free to drift
 * from the one a person actually reads.
 */
const REFUSING_BRIDGE = fixtureBridgeWithGrowth(REPOS_SCENARIO, {
  gitflowBranchContextRead: growthRefusing("gitflowBranchContextRead"),
});

function renderCard(
  overrides: Partial<React.ComponentProps<typeof MountCard>> = {},
): ReturnType<typeof render> {
  return render(
    // The announcer is the card's environment rather than its dependency: a root's
    // gate announces its settlement, and `useAnnounce` throws outside the provider
    // on purpose — a component speaking into nothing is invisible to everyone who
    // can see the screen.
    <LiveAnnouncerProvider>
      <MountCard
        mount={mount()}
        workspaces={[WORKSPACE]}
        capabilitiesByWorkspaceId={{}}
        workspaceRefusals={NO_WORKSPACE_REFUSALS}
        pendingModeByWorkspaceId={{}}
        worktrees={[]}
        worktreeRefusal={undefined}
        nowMilliseconds={Date.UTC(2026, 0, 1, 9, 5, 2)}
        bridge={REFUSING_BRIDGE}
        sessionStore={new SessionStore({ sessionId: "session-repos" })}
        onCopyCanonicalRoot={() => undefined}
        onSelectExecutionMode={() => undefined}
        {...overrides}
      />
    </LiveAnnouncerProvider>,
  );
}

/**
 * The card's head, which is where the resolved root lives.
 *
 * Scoped rather than document-wide: a read-only workspace legitimately roots AT the
 * mount's canonical root, so the same string appears on the card and on the row
 * beneath it, and a document-wide query would fail on a coincidence rather than on
 * the claim.
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
    const { container, getByText } = renderCard({
      mount: mount({ health: { status: "unreachable", checkedAt: "2026-01-01T09:05:01.000Z" } }),
    });
    expect(container.querySelector(".meridian-mount-card--withheld")).not.toBeNull();
    expect(getByText(/could not be probed/u)).toBeDefined();
    expect(container.querySelector("fieldset")).toBeNull();
  });

  it("negative control: a detached mount does not read as an unreachable one", () => {
    const { queryByText, getByText } = renderCard({ mount: mount({ state: "detached" }) });
    expect(getByText(/mints a new mount/u)).toBeDefined();
    expect(queryByText(/could not be probed/u)).toBeNull();
  });
});

describe("MountCard — the plain-directory mount", () => {
  it("badges reduced capability and names the reason", () => {
    const { getByText } = renderCard({ mount: mount({ vcsType: "none" }) });
    expect(getByText("reduced capability")).toBeDefined();
    expect(getByText(/git-specific features off/u)).toBeDefined();
  });

  it("negative control: a git mount carries no reduced-capability badge", () => {
    const { queryByText } = renderCard();
    expect(queryByText("reduced capability")).toBeNull();
  });
});

describe("MountCard — what the renderer must not offer", () => {
  it("negative control: nothing on the card is a detach control", () => {
    // `Spec-009 §Detach Semantics (V1 Definition)` gives the desktop renderer no
    // detach surface in V1, and there is no force option on a refused detach. This
    // case fails the moment either becomes a control rather than a sentence.
    const { container } = renderCard();
    for (const element of container.querySelectorAll("button, input, a")) {
      const description = `${element.getAttribute("aria-label") ?? ""} ${element.textContent ?? ""}`;
      expect(description.toLowerCase()).not.toContain("detach");
      expect(description.toLowerCase()).not.toContain("force");
    }
  });

  it("discloses where detach lives instead of omitting it silently", () => {
    const { getByText } = renderCard();
    expect(getByText(/command-line and SDK surfaces/u)).toBeDefined();
  });

  it("names the owning node, always", () => {
    const { getByTitle } = renderCard();
    expect(getByTitle("node-workstation")).toBeDefined();
  });
});

describe("MountCard — the roots, and the read that did not answer", () => {
  /** The root read's own failure, as `RepoMountsReader` hands it to the card. */
  const WORKTREE_REFUSAL = refuse(
    "repo.worktreeStatusRead",
    "wire-unregistered",
    "The execution-root read is not registered yet.",
  );

  const ROOT: WorktreeStatusRecord = worktreeRecord({
    worktreeId: "019b7b30-0280-7c11-8420-b1a5c0de2020",
    branchName: "feat/rate-limit-wiring",
    fsRoot: "/Users/dev/roots/rate-limit-wiring",
    createdAt: "2026-01-01T09:05:00.700Z",
    updatedAt: "2026-01-01T09:05:00.700Z",
  });

  /** What the empty arm says. Asserted by its own words, since it is what must be absent. */
  const NO_ROOT_COPY = /No execution root on disk/u;

  it("states the refusal and does not also report that there is no root", () => {
    // The reader supplies `worktrees: []` beside a refusal, so drawing the empty arm
    // here would be a successful-empty claim over a read that failed.
    const { getByText, queryByText } = renderCard({ worktreeRefusal: WORKTREE_REFUSAL });
    expect(getByText("wire-unregistered")).toBeDefined();
    expect(queryByText(NO_ROOT_COPY)).toBeNull();
  });

  it("negative control: a served empty root list still says there is no root", () => {
    // Without this the case above would pass against a card that had simply stopped
    // drawing the empty arm, which would leave a mount with no roots saying nothing.
    const { getByText, queryByText } = renderCard();
    expect(getByText(NO_ROOT_COPY)).toBeDefined();
    expect(queryByText("wire-unregistered")).toBeNull();
  });

  it("draws the roots the read named, and neither absence", () => {
    const { container, queryByText } = renderCard({ worktrees: [ROOT] });
    expect(container.querySelector(".meridian-root-gate-row")).not.toBeNull();
    expect(queryByText(NO_ROOT_COPY)).toBeNull();
  });
});

describe("the in-place root's gate", () => {
  /** The same workspace, executing where the mount itself is checked out. */
  const IN_PLACE_WORKSPACE: RepoWorkspaceRow = workspaceRow({ executionMode: "branch" });

  it("draws a gate under a workspace whose execution root IS the mount's checkout", () => {
    // `branch` mode mints no worktree and no clone, so a card that built gates only
    // from root records reached none of these workspaces at all — which left one of
    // the three writable modes unable to read a branch context or prepare anything.
    const { container } = renderCard({ workspaces: [IN_PLACE_WORKSPACE] });
    expect(container.querySelector("details.meridian-root-gate")).not.toBeNull();
  });

  it("says which key the read takes that an in-place root has none of", () => {
    const { getByText } = renderCard({ workspaces: [IN_PLACE_WORKSPACE] });
    // The refusal is the reader's own, because nothing refused it: no call was made.
    expect(getByText("subject-not-addressable")).toBeDefined();
  });

  it("negative control: a read-only workspace draws no gate", () => {
    // Without this the two cases above would pass against a card that hung a gate on
    // every workspace — including ones that produce no writable branch context and
    // have nothing to prepare.
    const { container, queryByText } = renderCard();
    expect(container.querySelector("details.meridian-root-gate")).toBeNull();
    expect(queryByText("subject-not-addressable")).toBeNull();
  });
});
