// The mount card: two axes, two paths, and one control the renderer must not have.
//
// Three negative controls carry `Spec-023 §Console Design (Meridian)` §10.1's three
// hardest claims: the resolved root is never shortened in the STRING, the two status
// axes are never one chip, and no detach control exists anywhere on the surface.

import type { RepoMountReadResponse } from "@ai-sidekicks/contracts";
import { render, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ConsoleBridge } from "../bridge/index.js";
import { LiveAnnouncerProvider } from "../primitives/index.js";
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

/**
 * A bridge whose every gate read refuses, which is what the live bridge does.
 *
 * The cast is `artifact-reader.test.ts`'s: this suite is about the card, and standing
 * up the whole preload contract to reach the one namespace a root's gate calls would
 * be scaffolding no assertion here reads.
 */
const REFUSING_BRIDGE = {
  growth: {
    gitflowBranchContextRead: async () => ({
      status: "unavailable",
      code: "wire-unregistered",
      origin: "growth-port",
      detail: "Not checked — the branch-context read is not registered yet.",
    }),
  },
} as unknown as ConsoleBridge;

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
        refusalByWorkspaceId={{}}
        worktrees={[]}
        worktreeRefusal={undefined}
        nowMilliseconds={Date.parse("2026-01-01T09:05:02.000Z")}
        bridge={REFUSING_BRIDGE}
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
