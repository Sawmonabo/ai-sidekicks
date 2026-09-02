// What the section draws once its one read burst has answered.
//
// The cases here drive the REAL section against the REAL fixture bridge, because the
// claim worth checking is that the daemon's answer reaches the screen — a hand-built
// reading would pin a shape the fixture could stop producing without either tier
// noticing. `Spec-023 §Console Design (Meridian)` §10.3 asks for two lists of
// execution roots, and until this file existed only one of them was drawn: the clone
// list had no production mount at all.

import { render, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createFixtureBridge } from "../bridge/index.js";
import type { ConsoleScenario } from "../bridge/scenario.js";
import { REPOS_SCENARIO } from "../bridge/scenarios/repos.js";
import { ManualClock } from "../core/index.js";
import { LiveAnnouncerProvider } from "../primitives/index.js";
import { SessionStore } from "../store/index.js";
import type { SidebarSectionContext } from "../workspace/index.js";
import { RepoSection } from "./RepoSection.js";

/** How long the section's read burst may take before a case gives up on it. */
const READ_TIMEOUT_MS = 5_000;

/** The clone list's own container, which is what separates it from the mount list. */
const CLONE_LIST_SELECTOR = ".meridian-repo-section__clones";

/** Both root cards render under one class, so a case scopes by container, not by card. */
const ROOT_CARD_SELECTOR = ".meridian-root-card";

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
        expect(list.querySelectorAll(ROOT_CARD_SELECTOR)).toHaveLength(1);
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
