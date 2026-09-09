// The controls the section and its rows carry.
//
// SPLIT FROM `RepoSection.test.tsx` ON THE SECTION'S OWN SEAM. That file is about what
// the one read burst puts on screen — the clone list, the mount cards, and the refusal a
// failed roster read renders. What follows is about the controls those rows wear once
// they are drawn: each writable execution root's change-proposal gate, the section's one
// mutating entry point, and a card's way into the deck. Both halves mount the real
// section against the real fixture bridge, which is why the mount and the container
// selectors they share live in `repo-section.test-support.tsx` rather than in either.

import { fireEvent, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { REPOS_SCENARIO } from "../../bridge/scenario/repos/repos.js";
import { GIT_WORKSPACE_ID } from "../../bridge/scenario/repos/repos-fixture-data.js";
import {
  cloneList,
  MOUNT_CARD_SELECTOR,
  renderSection,
  ROOT_CARD_SELECTOR,
} from "./repo-section.test-support.js";

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
    const section = renderSection(REPOS_SCENARIO);

    await section.advanceUntil(() => {
      expect(section.container.querySelectorAll(MOUNT_CARD_SELECTOR).length).toBeGreaterThan(0);
    });
    await section.advanceUntil(() => {
      expect(section.container.querySelectorAll(IN_PLACE_GATE_SELECTOR)).toHaveLength(1);
    });
    // In the in-place root's own words: the branch-context read is keyed by a context
    // id nothing this console can call mints, so the question is not put.
    const gate = section.container.querySelector(IN_PLACE_GATE_SELECTOR);
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
    const section = renderSection(REPOS_SCENARIO);
    const list = await cloneList(section);

    await section.advanceUntil(() => {
      // The cards first: an empty list would otherwise satisfy "one gate per card"
      // with zero of each, which is the vacuous pass this claim must not take.
      expect(list.querySelectorAll(ROOT_CARD_SELECTOR).length).toBeGreaterThan(0);
    });
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
    const section = renderSection(REPOS_SCENARIO);
    await cloneList(section);

    await section.advanceUntil(() => {
      expect(section.container.querySelectorAll(MOUNT_CARD_SELECTOR).length).toBeGreaterThan(0);
    });
    const worktreeGates = [...section.container.querySelectorAll(MOUNT_CARD_SELECTOR)].flatMap(
      (card) => [...card.querySelectorAll(`.meridian-root-gate-row ${GATE_SELECTOR}`)],
    );
    // Non-vacuous: a section that drew no worktree row at all would otherwise satisfy
    // an empty loop, which is the pass this control exists to refuse.
    expect(worktreeGates.length).toBeGreaterThan(0);
    for (const gate of worktreeGates) {
      expect(gate.textContent).not.toContain("subject-not-addressable");
    }
  });
});

describe("RepoSection — the one mutating entry point", () => {
  it("offers the attach on the section itself, above the mounts it already holds", async () => {
    // Before this the section could only ever REPORT repositories: `repo.attach` is a
    // registered daemon method and the console had no control that reached it, so a
    // session's first repository could not be started from the desktop at all.
    const section = renderSection(REPOS_SCENARIO);

    await section.advanceUntil(() => {
      expect(within(section.container).getByText("Attach a repository")).toBeDefined();
    });
  });

  it("negative control: the empty-mount card no longer sends a person to another client", async () => {
    // The card used to say attaching was reached through the command-line and SDK
    // surfaces, which was true of this console and false of the wire.
    const section = renderSection(REPOS_SCENARIO);

    await section.advanceUntil(() => {
      expect(within(section.container).getByText("Attach a repository")).toBeDefined();
    });
    expect(section.container.textContent).not.toContain("command-line and SDK");
  });
});

describe("RepoSection — a card's way into the deck", () => {
  it("opens a diff pane at the row's own address, in the deck it was handed", async () => {
    // THE OPENER IS THE SEAT'S AND NOT A MODULE THIS FAMILY IMPORTS, which is what the
    // section is proving here: a sidebar rendered in an auxiliary window opens its panes
    // in THAT window's deck, so every card's press has to arrive back through this
    // callback rather than through anything the family reached for itself.
    const openPane = vi.fn();
    const section = renderSection(REPOS_SCENARIO, openPane);
    await section.advanceUntil(() => {
      expect(
        within(section.container).getByLabelText(
          `Open the changes of workspace ${GIT_WORKSPACE_ID}`,
        ),
      ).toBeDefined();
    });
    fireEvent.click(
      within(section.container).getByLabelText(`Open the changes of workspace ${GIT_WORKSPACE_ID}`),
    );
    expect(openPane).toHaveBeenCalledWith({
      kind: "diff",
      entity: { kind: "workspace", id: GIT_WORKSPACE_ID },
    });
  });
});
