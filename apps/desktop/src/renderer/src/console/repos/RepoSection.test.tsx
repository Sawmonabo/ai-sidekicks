// What the section draws once its one read burst has answered.
//
// The cases here drive the REAL section against the REAL fixture bridge, because the
// claim worth checking is that the daemon's answer reaches the screen — a hand-built
// reading would pin a shape the fixture could stop producing without either tier
// noticing. `RepoSection.tsx` draws two lists of
// execution roots, and until this file existed only one of them was covered: the clone
// list had no production mount at all.

import { render, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createFixtureBridge } from "../bridge/index.js";
import type { ConsoleScenario, ScenarioReply } from "../bridge/scenario.js";
import { REPOS_SCENARIO } from "../bridge/scenarios/repos.js";
import { ManualClock } from "../core/index.js";
import { LiveAnnouncerProvider } from "../primitives/index.js";
import { SessionStore } from "../store/index.js";
import type { SidebarSectionContext } from "../seats/index.js";
import { RepoSection } from "./RepoSection.js";

/** How long the section's read burst may take before a case gives up on it. */
const READ_TIMEOUT_MS = 5_000;

/** The clone list's own container, which is what separates it from the mount list. */
const CLONE_LIST_SELECTOR = ".meridian-repo-section__clones";

/** Both root cards render under one class, so a case scopes by container, not by card. */
const ROOT_CARD_SELECTOR = ".meridian-root-card";

/** One card per mount. Read from the container, since the list has no element of its own. */
const MOUNT_CARD_SELECTOR = ".meridian-mount-card";

/** A root read that answered and named nothing — the lawful two-empty-arrays reply. */
const SERVED_EMPTY_ROOT_READ: ScenarioReply = {
  call: "repo.worktreeStatusRead",
  result: { worktrees: [], ephemeralClones: [] },
};

/**
 * The section, open, over one scenario, inside the window's announcer.
 *
 * The announcer is the section's environment rather than a nicety: each root's gate
 * announces its own settlement and `useAnnounce` throws outside the provider. Frozen
 * time, so nothing here races the announcer's own hold deadline.
 */
function renderSection(scenario: ConsoleScenario): HTMLElement {
  const context: SidebarSectionContext = {
    isOpen: true,
    bridge: createFixtureBridge({ scenario }),
    sessionStore: new SessionStore({ sessionId: scenario.sessionId }),
    openPane: () => undefined,
  };
  const { container } = render(
    <LiveAnnouncerProvider clock={new ManualClock()}>
      <RepoSection context={context} />
    </LiveAnnouncerProvider>,
  );
  return container;
}

/** Wait until the section's clone list exists, and hand it back. */
async function cloneList(container: HTMLElement): Promise<HTMLElement> {
  await waitFor(
    () => {
      if (container.querySelector(CLONE_LIST_SELECTOR) === null) {
        throw new Error("the section has not drawn its clone list yet");
      }
    },
    { timeout: READ_TIMEOUT_MS },
  );
  const list = container.querySelector(CLONE_LIST_SELECTOR);
  if (!(list instanceof HTMLElement)) {
    throw new Error(`nothing in the section matches \`${CLONE_LIST_SELECTOR}\``);
  }
  return list;
}

describe("RepoSection — the ephemeral clones the root read named", () => {
  it("draws a card for each clone the daemon answered with", async () => {
    const container = renderSection(REPOS_SCENARIO);
    const list = await cloneList(container);

    await waitFor(
      () => {
        // One card per clone the read named, and the scenario names two: an unswept
        // one past its deadline and a swept one whose deadline is still ahead. A list
        // that drew one of them would be dropping a root the daemon reported.
        expect(list.querySelectorAll(ROOT_CARD_SELECTOR)).toHaveLength(2);
      },
      { timeout: READ_TIMEOUT_MS },
    );
    // The heading names the execution mode these roots belong to, in the contract's
    // own spelling — so the list says what it is rather than leaving a reader to infer
    // it from the columns.
    expect(within(list).getByRole("heading", { level: 4, name: /ephemeral clone/ })).toBeDefined();
  });

  it("says the clones were not read when the root read refused", async () => {
    // Rule 8: the root read is the only read that names a clone, so a refused one
    // leaves the list `not-checked` — never `empty`, which would report "there are
    // none" for a question nothing answered.
    const container = renderSection({
      ...REPOS_SCENARIO,
      id: "repos-root-read-refused",
      replies: REPOS_SCENARIO.replies.filter((reply) => reply.call !== "repo.worktreeStatusRead"),
    });
    const list = await cloneList(container);

    await waitFor(
      () => {
        expect(within(list).getByText("Ephemeral clones have not been read.")).toBeDefined();
      },
      { timeout: READ_TIMEOUT_MS },
    );
    expect(list.querySelectorAll(ROOT_CARD_SELECTOR)).toHaveLength(0);
  });
});

describe("RepoSection — the clone list stands on its own read", () => {
  it("draws the clones a served root read named even where a mount read refused", async () => {
    // `repo.mountRead` is per mount and `repo.worktreeStatusRead` is per session. One
    // mount that could not be probed says nothing about the roots this session holds,
    // and gating the list on it took valid execution roots off the screen.
    const container = renderSection({
      ...REPOS_SCENARIO,
      id: "repos-mount-read-refused-clones-served",
      replies: REPOS_SCENARIO.replies.filter((reply) => reply.call !== "repo.mountRead"),
    });
    const list = await cloneList(container);

    await waitFor(
      () => {
        expect(list.querySelectorAll(ROOT_CARD_SELECTOR)).toHaveLength(2);
      },
      { timeout: READ_TIMEOUT_MS },
    );
    // The mount failure is still reported — it is drawn beside the mounts, not instead
    // of the clones.
    expect(container.querySelector(".meridian-refusal--card")).not.toBeNull();
  });

  it("says nobody asked when the read burst stopped before the root call", async () => {
    // The workspace list is what the burst opens with, so a refused one never reaches
    // the root read: there is no refusal of its own to report and no served empty
    // either. `empty` here would claim this session holds no clone.
    const container = renderSection({
      ...REPOS_SCENARIO,
      id: "repos-workspace-list-refused",
      replies: REPOS_SCENARIO.replies.filter((reply) => reply.call !== "repo.workspaceList"),
    });
    const list = await cloneList(container);

    await waitFor(
      () => {
        // The DETAIL rather than the title: the pre-read frame carries the same title,
        // so a case that waited on it would settle before the burst it is about.
        expect(within(list).getByText(/stopped before the execution-root call/u)).toBeDefined();
      },
      { timeout: READ_TIMEOUT_MS },
    );
    expect(list.querySelectorAll(ROOT_CARD_SELECTOR)).toHaveLength(0);
  });

  it("negative control: a fully served section still says there is no clone where there is none", async () => {
    // Without this, a list that answered `not-checked` for every settled read would
    // pass both cases above and never report a served empty session at all.
    const container = renderSection({
      ...REPOS_SCENARIO,
      id: "repos-no-clones",
      replies: [
        ...REPOS_SCENARIO.replies.filter((reply) => reply.call !== "repo.worktreeStatusRead"),
        // Rebuilt rather than spread over the scripted row: `ScenarioReply` is a union
        // whose arms exclude each other's members, so a spread would carry a `refusal`
        // key the resolving arm forbids.
        SERVED_EMPTY_ROOT_READ,
      ],
    });
    const list = await cloneList(container);

    await waitFor(
      () => {
        expect(within(list).getByText("This session holds no ephemeral clone.")).toBeDefined();
      },
      { timeout: READ_TIMEOUT_MS },
    );
  });
});

describe("RepoSection — the mounts this session actually holds", () => {
  it("draws a card per mount, each carrying its own health verdict", async () => {
    const container = renderSection(REPOS_SCENARIO);

    await waitFor(
      () => {
        expect(container.querySelectorAll(MOUNT_CARD_SELECTOR)).toHaveLength(2);
      },
      { timeout: READ_TIMEOUT_MS },
    );
    // Health is the axis only `repo.mountRead` carries, and it is the one that decides
    // whether the sidebar opens this section at all. One card of each verdict, so the
    // healthy and the degraded rendering are both reachable from one session.
    const [healthy, unreachable] = [...container.querySelectorAll(MOUNT_CARD_SELECTOR)];
    expect(within(healthy as HTMLElement).getByText("healthy")).toBeDefined();
    expect(within(unreachable as HTMLElement).getByText("unreachable")).toBeDefined();
    // Each card names the root it is about, so the two are two mounts rather than one
    // mount drawn twice.
    expect(healthy?.getAttribute("aria-label")).not.toBe(unreachable?.getAttribute("aria-label"));
  });

  it("negative control: a section whose mount reads are unscripted draws no card", async () => {
    // Without this, a list that rendered a card per WORKSPACE would pass the case
    // above while never having read a mount at all.
    const container = renderSection({
      ...REPOS_SCENARIO,
      id: "repos-mount-read-refused",
      replies: REPOS_SCENARIO.replies.filter((reply) => reply.call !== "repo.mountRead"),
    });

    await waitFor(
      () => {
        expect(container.querySelector(".meridian-refusal--card")).not.toBeNull();
      },
      { timeout: READ_TIMEOUT_MS },
    );
    expect(container.querySelectorAll(MOUNT_CARD_SELECTOR)).toHaveLength(0);
  });
});

describe("RepoSection — the in-place root reaches the screen from the scenario", () => {
  /** The in-place root's gate sits on the workspace itself, because that IS the root. */
  const IN_PLACE_GATE_SELECTOR = ".meridian-mount-card__workspace > details.meridian-root-gate";

  it("draws one gate for the branch-mode workspace and none for the read-only one", async () => {
    // A workspace has three writable execution modes and the third one — `branch` —
    // mints no worktree and no clone, so its gate hangs on the workspace card. While
    // every scenario row was bound `read-only` the fixture reached two of the three
    // roots, and the screenshot and accessibility tiers framed a section the in-place
    // gate never appeared in.
    //
    // Exactly one is the negative control as well as the claim: the scenario states
    // two workspaces, and a card that hung a gate on every one of them — including the
    // read-only row that produces no writable branch context — would draw two.
    const container = renderSection(REPOS_SCENARIO);

    await waitFor(
      () => {
        expect(container.querySelectorAll(MOUNT_CARD_SELECTOR).length).toBeGreaterThan(0);
      },
      { timeout: READ_TIMEOUT_MS },
    );
    await waitFor(
      () => {
        expect(container.querySelectorAll(IN_PLACE_GATE_SELECTOR)).toHaveLength(1);
      },
      { timeout: READ_TIMEOUT_MS },
    );
    // In the in-place root's own words: the branch-context read is keyed by a context
    // id nothing this console can call mints, so the question is not put.
    const gate = container.querySelector(IN_PLACE_GATE_SELECTOR);
    expect(gate?.textContent).toContain("not addressable");
  });
});

describe("RepoSection — a clone root is a writable root, so it carries a gate", () => {
  /** The disclosure a root's change-proposal gate renders into. */
  const GATE_SELECTOR = "details.meridian-root-gate";

  it("mounts one gate per clone, inside the clone's own row", async () => {
    // Before this the clone list drew bare cards, so a participant running in the
    // ephemeral clone mode had no way to read a branch context, prepare a proposal,
    // or ask for a reviewed act at all.
    const container = renderSection(REPOS_SCENARIO);
    const list = await cloneList(container);

    await waitFor(
      () => {
        // The cards first: an empty list would otherwise satisfy "one gate per card"
        // with zero of each, which is the vacuous pass this claim must not take.
        expect(list.querySelectorAll(ROOT_CARD_SELECTOR).length).toBeGreaterThan(0);
      },
      { timeout: READ_TIMEOUT_MS },
    );
    expect(list.querySelectorAll(GATE_SELECTOR)).toHaveLength(
      list.querySelectorAll(ROOT_CARD_SELECTOR).length,
    );
    // The clone's own refusal, in the clone's own words: its id is a REPLY member, so
    // the registered read cannot be asked by it and the question is not put.
    expect(within(list).getAllByText("subject-not-addressable").length).toBeGreaterThan(0);
  });

  it("negative control: a worktree root's gate is still asked, and refuses differently", async () => {
    // Without this the case above would pass against a section that had made every
    // gate unaddressable — which would silently retire the one root the registered
    // request does have a key for.
    //
    // SCOPED TO THE ROOT ROWS, not to the whole mount card. The scenario's git
    // workspace is bound `branch`, so its card also carries the in-place root's gate —
    // and that one IS unaddressable, for the same reason the clone's is. The claim
    // here is about the worktree roots, which are the rows; a card-wide sweep would
    // read the workspace's own gate as a worktree's and fail on the fixture stating
    // the third writable mode at all.
    const container = renderSection(REPOS_SCENARIO);
    await cloneList(container);

    await waitFor(
      () => {
        expect(container.querySelectorAll(MOUNT_CARD_SELECTOR).length).toBeGreaterThan(0);
      },
      { timeout: READ_TIMEOUT_MS },
    );
    const worktreeGates = [...container.querySelectorAll(MOUNT_CARD_SELECTOR)].flatMap((card) => [
      ...card.querySelectorAll(`.meridian-root-gate-row ${GATE_SELECTOR}`),
    ]);
    // Non-vacuous: a section that drew no worktree row at all would otherwise satisfy
    // an empty loop, which is the pass this control exists to refuse.
    expect(worktreeGates.length).toBeGreaterThan(0);
    for (const gate of worktreeGates) {
      expect(gate.textContent).not.toContain("subject-not-addressable");
    }
  });
});
