// How every RepoSection suite mounts the section, and the containers its cases read.
//
// The section is mounted for real over scripted daemon calls, under the window's
// announcer, on a frozen clock the case moves. The claim worth checking is that the
// daemon's answer reaches the screen, and a hand-built reading would pin a shape the
// reader could stop producing without either tier noticing.

import { render } from "@testing-library/react";

import { advanceScenarioUntil } from "@test/helpers/scenario-manual-clock.js";
import { ManualClock } from "@renderer/lib/clock.js";
import { LiveAnnouncerProvider } from "@renderer/console/primitives/index.js";
import type { PaneOpener } from "@renderer/console/seats/index.js";
import { SessionStore } from "@renderer/store/session/session-store.js";
import type { RepoOperations } from "../repo-operations.js";
import { bridgeOnClock } from "@test/helpers/fixture-bridge.js";
import { bridgeWrapper } from "@test/helpers/app-frame-fixtures.js";
import { RepoSection } from "./RepoSection.js";
import { SESSION_ID } from "./repo-mounts.test-support.js";

/** One card per mount. Read from the container, since the list has no element of its own. */
export const MOUNT_CARD_SELECTOR = ".meridian-mount-card";

/** One rendered section, and the frozen clock its reads are waiting on. */
export interface SectionUnderTest {
  readonly container: HTMLElement;
  /**
   * Drive time until `assert` holds, or fail with `assert`'s own message.
   *
   * The section schedules every read through the console's one `RefreshScheduler`, which
   * arms its debounce on the scenario's clock, so nothing this section is waiting on
   * happens until a case moves that clock, and polling real time would poll a still
   * picture.
   */
  readonly advanceUntil: (assert: () => void) => Promise<void>;
}

/** The section, open, over scripted calls, inside the window's announcer. */
export function renderSection(
  operations: RepoOperations,
  openPane: PaneOpener = () => {},
): SectionUnderTest {
  const { bridge, scenarioEngine, clock } = bridgeOnClock("repos");
  const { container } = render(
    <LiveAnnouncerProvider clock={new ManualClock()}>
      <RepoSection
        bridge={bridge}
        sessionStore={new SessionStore({ sessionId: SESSION_ID })}
        operations={operations}
        isOpen
        openPane={openPane}
      />
    </LiveAnnouncerProvider>,
    { wrapper: bridgeWrapper(bridge, clock) },
  );
  return {
    container,
    advanceUntil: async (assert: () => void) => {
      await advanceScenarioUntil(scenarioEngine, assert);
    },
  };
}
