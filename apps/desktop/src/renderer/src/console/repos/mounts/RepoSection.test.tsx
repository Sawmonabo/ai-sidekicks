// What the section's one read burst puts on screen.
//
// The cases here drive the REAL section against the REAL fixture bridge, because the
// claim worth checking is that the daemon's answer reaches the screen — a hand-built
// reading would pin a shape the fixture could stop producing without either tier
// noticing. `RepoSection.tsx` draws two lists of execution roots, and until this file
// existed only one of them was covered: the clone list had no production mount at all.
//
// THE CONTROLS THE SECTION AND ITS ROWS CARRY are `RepoSection.controls.test.tsx`,
// beside this file: each writable root's change-proposal gate, the attach, and a card's
// way into the deck are read for a different reason and share none of these subjects.

import { within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ScenarioReply } from "../../bridge/scenario/runtime/reply.js";
import { REPOS_SCENARIO } from "../../bridge/scenario/repos/repos.js";
import { NOT_READ_TITLE } from "./repo-mounts-copy.js";
import { CLONE_EXPIRY_COPY } from "./worktree-model.js";
import {
  cloneList,
  MOUNT_CARD_SELECTOR,
  renderSection,
  ROOT_CARD_SELECTOR,
} from "./repo-section.test-support.js";

/** A root read that answered and named nothing — the lawful two-empty-arrays reply. */
const SERVED_EMPTY_ROOT_READ: ScenarioReply = {
  call: "repo.worktreeStatusRead",
  result: { worktrees: [], ephemeralClones: [] },
};

describe("RepoSection — the ephemeral clones the root read named", () => {
  it("draws a card for each clone the daemon answered with", async () => {
    const section = renderSection(REPOS_SCENARIO);
    const list = await cloneList(section);

    await section.advanceUntil(() => {
      // One card per clone the read named, and the scenario names two: an unswept
      // one past its deadline and a swept one whose deadline is still ahead. A list
      // that drew one of them would be dropping a root the daemon reported.
      expect(list.querySelectorAll(ROOT_CARD_SELECTOR)).toHaveLength(2);
    });
    // The heading names the execution mode these roots belong to, in the contract's
    // own spelling — so the list says what it is rather than leaving a reader to infer
    // it from the columns.
    expect(within(list).getByRole("heading", { level: 4, name: /ephemeral clone/ })).toBeDefined();
  });

  it("draws the undisposed clone on the scheduled arm, on the fixture's own clock", async () => {
    // WHICH ARM A CLONE IS ON IS A FACT ABOUT A CLOCK. The scenario's unswept clone is
    // due 1.5 seconds into the scenario, so on the bridge's frozen clock it is still
    // scheduled; against the machine's it is years past its deadline and the card reads
    // amber. That was the section's composition until the reader took its clock from
    // the bridge, and it is the half of that defect a person can see.
    const section = renderSection(REPOS_SCENARIO);
    const list = await cloneList(section);

    await section.advanceUntil(() => {
      expect(list.querySelectorAll(ROOT_CARD_SELECTOR)).toHaveLength(2);
    });

    expect(within(list).getByText(CLONE_EXPIRY_COPY.scheduled)).toBeDefined();
    expect(within(list).queryByText(CLONE_EXPIRY_COPY.elapsed)).toBeNull();
  });

  it("says the clones were not read when the root read refused", async () => {
    // Rule 8: the root read is the only read that names a clone, so a refused one
    // leaves the list `not-checked` — never `empty`, which would report "there are
    // none" for a question nothing answered.
    const section = renderSection({
      ...REPOS_SCENARIO,
      id: "repos-root-read-refused",
      replies: REPOS_SCENARIO.replies.filter((reply) => reply.call !== "repo.worktreeStatusRead"),
    });
    const list = await cloneList(section);

    await section.advanceUntil(() => {
      expect(within(list).getByText("Ephemeral clones have not been read.")).toBeDefined();
    });
    expect(list.querySelectorAll(ROOT_CARD_SELECTOR)).toHaveLength(0);
  });
});

describe("RepoSection — the clone list stands on its own read", () => {
  it("draws the clones a served root read named even where a mount read refused", async () => {
    // `repo.mountRead` is per mount and `repo.worktreeStatusRead` is per session. One
    // mount that could not be probed says nothing about the roots this session holds,
    // and gating the list on it took valid execution roots off the screen.
    const section = renderSection({
      ...REPOS_SCENARIO,
      id: "repos-mount-read-refused-clones-served",
      replies: REPOS_SCENARIO.replies.filter((reply) => reply.call !== "repo.mountRead"),
    });
    const list = await cloneList(section);

    await section.advanceUntil(() => {
      expect(list.querySelectorAll(ROOT_CARD_SELECTOR)).toHaveLength(2);
    });
    // The mount failure is still reported — it is drawn beside the mounts, not instead
    // of the clones.
    expect(section.container.querySelector(".meridian-refusal--card")).not.toBeNull();
  });

  it("says nobody asked when the read burst stopped before the root call", async () => {
    // The workspace list is what the burst opens with, so a refused one never reaches
    // the root read: there is no refusal of its own to report and no served empty
    // either. `empty` here would claim this session holds no clone.
    const section = renderSection({
      ...REPOS_SCENARIO,
      id: "repos-workspace-list-refused",
      replies: REPOS_SCENARIO.replies.filter((reply) => reply.call !== "repo.workspaceList"),
    });
    const list = await cloneList(section);

    await section.advanceUntil(() => {
      // The DETAIL rather than the title: the pre-read frame carries the same title,
      // so a case that waited on it would settle before the burst it is about.
      expect(within(list).getByText(/stopped before the execution-root call/u)).toBeDefined();
    });
    expect(list.querySelectorAll(ROOT_CARD_SELECTOR)).toHaveLength(0);
  });

  it("negative control: a fully served section still says there is no clone where there is none", async () => {
    // Without this, a list that answered `not-checked` for every settled read would
    // pass both cases above and never report a served empty session at all.
    const section = renderSection({
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
    const list = await cloneList(section);

    await section.advanceUntil(() => {
      expect(within(list).getByText("This session holds no ephemeral clone.")).toBeDefined();
    });
  });
});

describe("RepoSection — the mounts this session actually holds", () => {
  it("draws a card per mount, each carrying its own health verdict", async () => {
    const section = renderSection(REPOS_SCENARIO);

    await section.advanceUntil(() => {
      expect(section.container.querySelectorAll(MOUNT_CARD_SELECTOR)).toHaveLength(3);
    });
    // Health is the axis only `repo.mountRead` carries, and it is the one that decides
    // whether the sidebar opens this section at all. One card of each verdict — the
    // whole of `RepoMountHealth.status` — so every rendering is reachable from one
    // session rather than two of three being unreachable from any.
    const [healthy, unreachable, drifted] = [
      ...section.container.querySelectorAll(MOUNT_CARD_SELECTOR),
    ];
    expect(within(healthy as HTMLElement).getByText("healthy")).toBeDefined();
    expect(within(unreachable as HTMLElement).getByText("unreachable")).toBeDefined();
    expect(within(drifted as HTMLElement).getByText("identity_mismatch")).toBeDefined();
    // Each card names the root it is about, so the three are three mounts rather than
    // one mount drawn three times.
    const labels = [healthy, unreachable, drifted].map((card) => card?.getAttribute("aria-label"));
    expect(new Set(labels).size).toBe(3);
  });

  it("negative control: a section whose mount reads are unscripted draws no card", async () => {
    // Without this, a list that rendered a card per WORKSPACE would pass the case
    // above while never having read a mount at all.
    const section = renderSection({
      ...REPOS_SCENARIO,
      id: "repos-mount-read-refused",
      replies: REPOS_SCENARIO.replies.filter((reply) => reply.call !== "repo.mountRead"),
    });

    await section.advanceUntil(() => {
      expect(section.container.querySelector(".meridian-refusal--card")).not.toBeNull();
    });
    expect(section.container.querySelectorAll(MOUNT_CARD_SELECTOR)).toHaveLength(0);
  });
});

describe("RepoSection — a refused read says so once, and never says it was not made", () => {
  it("draws the refusal card and no unread line when the roster read refuses", async () => {
    // The roster is the read every other one hangs off, so refusing it is the shape
    // that leaves the section with a refusal and nothing else. The list used to fall
    // through its own absence ladder to `not-checked` here and report "have not been
    // read" underneath the card explaining what the read answered — rule 8's
    // `not-checked` standing in for a refusal, one line below the refusal itself.
    const section = renderSection({
      ...REPOS_SCENARIO,
      id: "repos-workspace-list-refused",
      replies: REPOS_SCENARIO.replies.filter((reply) => reply.call !== "repo.workspaceList"),
    });

    await section.advanceUntil(() => {
      expect(section.container.querySelector(".meridian-refusal--card")).not.toBeNull();
    });
    expect(section.container.querySelectorAll(MOUNT_CARD_SELECTOR)).toHaveLength(0);
    expect(section.container.textContent).not.toContain(NOT_READ_TITLE);
    // And the refusal is said ONCE: the card above the list carries it, so the list
    // renders nothing rather than a second copy of the same code and detail.
    expect(section.container.querySelectorAll(".meridian-refusal--card")).toHaveLength(1);
  });

  it("negative control: a section whose reads have not settled does say it has not read", async () => {
    // Without this the assertion above would pass on a section that had simply stopped
    // rendering that sentence anywhere, rather than on one that stopped rendering it
    // where a refusal already stood. Nothing is advanced, so the read is still unmade.
    const section = renderSection(REPOS_SCENARIO);

    expect(section.container.textContent).toContain(NOT_READ_TITLE);
    expect(section.container.querySelector(".meridian-refusal--card")).toBeNull();
  });
});
