// The mount card: two axes, two paths, and one control the renderer must not have.
//
// Three negative controls carry `Spec-023 §Console Design (Meridian)` §10.1's three
// hardest claims: the resolved root is never shortened in the STRING, the two status
// axes are never one chip, and no detach control exists anywhere on the surface.

import type { RepoMountReadResponse } from "@ai-sidekicks/contracts";
import { render, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MountCard } from "./MountCard.js";
import type { RepoWorkspaceRow } from "./repo-mounts-reader.js";

const CANONICAL_ROOT = "/Users/dev/code/ai-sidekicks";
const ENTERED_PATH = "/Users/dev/code/ai-sidekicks/packages/contracts";

function mount(overrides: Partial<RepoMountReadResponse> = {}): RepoMountReadResponse {
  return {
    id: "mount-sidekicks",
    sessionId: "session-repos",
    nodeId: "node-workstation",
    localPath: ENTERED_PATH,
    canonicalRoot: CANONICAL_ROOT,
    vcsType: "git",
    state: "attached",
    health: { status: "healthy", checkedAt: "2026-01-01T09:05:01.000Z" },
    attachedAt: "2026-01-01T09:05:00.200Z",
    ...overrides,
  } as RepoMountReadResponse;
}

const WORKSPACE: RepoWorkspaceRow = {
  id: "workspace-sidekicks",
  repoMountId: "mount-sidekicks",
  executionMode: "read-only",
  state: "ready",
  fsRoot: CANONICAL_ROOT,
} as RepoWorkspaceRow;

function renderCard(
  overrides: Partial<React.ComponentProps<typeof MountCard>> = {},
): ReturnType<typeof render> {
  return render(
    <MountCard
      mount={mount()}
      workspaces={[WORKSPACE]}
      capabilitiesByWorkspaceId={{}}
      refusalByWorkspaceId={{}}
      onCopyCanonicalRoot={() => undefined}
      onSelectExecutionMode={() => undefined}
      {...overrides}
    />,
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
    // would make two different roots render identically, which is the one thing §10.1
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
