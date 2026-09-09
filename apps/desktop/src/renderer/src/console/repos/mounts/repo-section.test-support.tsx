// How every RepoSection suite mounts the section, and the containers its cases read.
//
// HOISTED WHEN THE SECTION'S CASES SPLIT IN TWO. The section answers two questions read
// for different reasons — what its one read burst PUTS ON SCREEN (the clone list, the
// mount cards, and the refusal a failed roster read renders) and what CONTROLS the
// section and its rows carry (each writable root's change-proposal gate, the attach, and
// a card's way into the deck) — and each half is a suite. Both mount the real section
// against the real fixture bridge under the window's announcer, so the mount and the
// three container selectors live here rather than being written twice.
//
// THE FIXTURE BRIDGE AND NOT A HAND-BUILT READING, which is the reason these suites
// exist at all: the claim worth checking is that the daemon's answer reaches the screen,
// and a hand-built reading would pin a shape the fixture could stop producing without
// either tier noticing.

import { render } from "@testing-library/react";

import { createFixtureBridge } from "../../bridge/index.js";
import type { ConsoleScenario } from "../../bridge/scenario/runtime/vocabulary.js";
import { ManualClock } from "../../core/index.js";
import { LiveAnnouncerProvider } from "../../primitives/index.js";
import type { ConsolePaneOpener } from "../../seats/index.js";
import { SessionStore } from "../../store/index.js";
import { advanceScenarioUntil } from "../../bridge/scenario/runtime/clock.test-support.js";
import { sectionContext } from "../pane-contexts.test-support.js";
import { RepoSection } from "./RepoSection.js";

/** The clone list's own container, which is what separates it from the mount list. */
export const CLONE_LIST_SELECTOR = ".meridian-repo-section__clones";

/** Both root cards render under one class, so a case scopes by container, not by card. */
export const ROOT_CARD_SELECTOR = ".meridian-root-card";

/** One card per mount. Read from the container, since the list has no element of its own. */
export const MOUNT_CARD_SELECTOR = ".meridian-mount-card";

/** One rendered section, and the frozen clock its reads are waiting on. */
export interface SectionUnderTest {
  readonly container: HTMLElement;
  /**
   * Drive scenario time until `assert` holds, or fail with `assert`'s own message.
   *
   * THE REPLACEMENT FOR `waitFor`, and the replacement rather than a companion: the
   * section schedules every read through the console's one `RefreshScheduler`, which
   * arms its debounce on the clock it was handed — the bridge's. Under the fixture
   * that is the scenario's frozen clock, so nothing this surface is waiting on
   * happens until a case moves it, and polling real time would poll a still picture.
   */
  readonly advanceUntil: (assert: () => void) => Promise<void>;
}

/**
 * The section, open, over one scenario, inside the window's announcer.
 *
 * The announcer is the section's environment rather than a nicety: each root's gate
 * announces its own settlement and `useAnnounce` throws outside the provider. Frozen
 * time, so nothing here races the announcer's own hold deadline.
 */
export function renderSection(
  scenario: ConsoleScenario,
  openPane?: ConsolePaneOpener,
): SectionUnderTest {
  const bridge = createFixtureBridge({ scenario });
  const context = sectionContext({
    isOpen: true,
    bridge,
    sessionStore: new SessionStore({ sessionId: scenario.sessionId }),
    ...(openPane === undefined ? {} : { openPane }),
  });
  const { container } = render(
    <LiveAnnouncerProvider clock={new ManualClock()}>
      <RepoSection context={context} />
    </LiveAnnouncerProvider>,
  );
  return {
    container,
    advanceUntil: async (assert: () => void) => {
      await advanceScenarioUntil(bridge, assert);
    },
  };
}

/** Drive the section until its clone list exists, and hand it back. */
export async function cloneList(section: SectionUnderTest): Promise<HTMLElement> {
  await section.advanceUntil(() => {
    if (section.container.querySelector(CLONE_LIST_SELECTOR) === null) {
      throw new Error("the section has not drawn its clone list yet");
    }
  });
  const list = section.container.querySelector(CLONE_LIST_SELECTOR);
  if (!(list instanceof HTMLElement)) {
    throw new Error(`nothing in the section matches \`${CLONE_LIST_SELECTOR}\``);
  }
  return list;
}
