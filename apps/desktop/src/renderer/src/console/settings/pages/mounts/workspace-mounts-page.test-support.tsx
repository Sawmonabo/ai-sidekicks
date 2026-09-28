// The mounts page's own harness: a settings context, the two inventory calls as plain
// stubs, and a render that settles the two chained reads behind them.
//
// BESIDE `mounts.test-support.ts` RATHER THAN INSIDE IT. That module is the FIXTURE
// vocabulary — mount ids, the two workspace rows, the shapes a read answers with —
// and it is a `.ts` because none of it renders. What is here mounts a React tree and
// holds a live announcer, so it is a `.tsx`, and the two suites that drive this page
// share it rather than each carrying its own copy of the call stubs.

import type { RepoMountReadResponse, WorkspaceListResponse } from "@ai-sidekicks/contracts";
import { act, render } from "@testing-library/react";

import { DesktopBridgeProvider, createFixtureBridge } from "../../../bridge/index.js";
import { unscriptedScenario } from "../../../bridge/fixture/call-plane/bridge.test-support.js";
import { ManualClock } from "../../../core/index.js";
import { PAST_REFRESH_DEBOUNCE_MS } from "../../../core/settle.test-support.js";
import { LiveAnnouncer, LiveAnnouncerProvider } from "../../../primitives/index.js";
import { politeText } from "../../../primitives/announce/live-region.test-support.js";
import type { SessionStore } from "../../../store/index.js";
import { frozenClockOf } from "../../../bridge/readings/scheduled-read.test-support.js";
import { settingsPageContextWith } from "../../settings-page-mount.test-support.js";
import type { SettingsPageContext } from "../../settings-page-registry.js";
import { SESSION_ID, mountReadFor, workspaceListWith } from "./mounts.test-support.js";
import { MountInventoryList } from "./MountInventoryList.js";
import type { MountInventoryCalls } from "./mount-inventory.js";
import { WorkspaceMountsPage } from "./WorkspaceMountsPage.js";

/**
 * A settings context on a clock the test owns, and the two calls the inventory reads
 * through, answered from plain stubs.
 *
 * The bridge is the shipped fixture, which is where the page looks for its clock and
 * its reconnect signal; the calls are separate because they are an argument of the
 * list and no longer a method of the bridge. The clock is handed back beside the
 * context, because a case that advanced a clock the page was not reading would be
 * asserting about a timer that never fell due.
 */
export function contextReading(options: {
  readonly mountIds: readonly string[];
  readonly mountOverrides?: Readonly<Record<string, Partial<RepoMountReadResponse>>>;
  /** The retained session's store, where the window has one open. */
  readonly sessionStore?: SessionStore | undefined;
  /** Counts what the page asked for, so a refresh can be proved rather than assumed. */
  readonly onCall?: (call: "workspaceList" | "mountRead") => void;
  /** Makes the calls reject with this message, which fails the read. */
  readonly rejectWith?: string;
  /**
   * How many calls `rejectWith` covers. Unbounded when omitted.
   *
   * A bounded count is what drives RECOVERY: a first attempt that fails and a second
   * that answers.
   */
  readonly rejectionCount?: number;
}): {
  readonly context: SettingsPageContext;
  readonly clock: ManualClock;
  readonly calls: MountInventoryCalls;
} {
  let rejectedCallCount = 0;
  const fixture = createFixtureBridge({ scenario: unscriptedScenario("workspace-mounts-page") });
  const clock = frozenClockOf(fixture);
  const rejectIfAsked = (): void => {
    if (
      options.rejectWith !== undefined &&
      rejectedCallCount < (options.rejectionCount ?? Number.POSITIVE_INFINITY)
    ) {
      rejectedCallCount += 1;
      throw new Error(options.rejectWith);
    }
  };
  const calls: MountInventoryCalls = {
    workspaceList: (): Promise<WorkspaceListResponse> => {
      options.onCall?.("workspaceList");
      rejectIfAsked();
      return Promise.resolve(workspaceListWith(options.mountIds));
    },
    mountRead: (request): Promise<RepoMountReadResponse> => {
      options.onCall?.("mountRead");
      rejectIfAsked();
      return Promise.resolve(
        mountReadFor(request.repoMountId, options.mountOverrides?.[request.repoMountId] ?? {}),
      );
    },
  };
  return {
    context: settingsPageContextWith(fixture, SESSION_ID, {
      retainedSessionStore: options.sessionStore,
    }),
    clock,
    calls,
  };
}

/** The page's own element, so a case never reads the announcer's regions by accident. */
export function mountsPageOf(root: HTMLElement): HTMLElement {
  const page = root.querySelector<HTMLElement>(".meridian-settings-page");
  if (page === null) {
    throw new Error("the mounts page did not render");
  }
  return page;
}

/**
 * Mount, advance past the coalescing window, and let the two chained reads settle.
 *
 * The read itself is the real one and only the wire is a stand-in. Settling is one
 * turn of the macrotask queue rather than a counted run of microtask flushes,
 * because the number of ticks a fan-out takes is a function of how many mounts the
 * fixture named.
 */
export async function renderSettledPage(reading: {
  readonly context: SettingsPageContext;
  readonly clock: ManualClock;
  readonly calls: MountInventoryCalls;
}): Promise<{
  readonly page: HTMLElement;
  readonly clock: ManualClock;
  readonly politeText: () => string;
  readonly settle: () => Promise<void>;
}> {
  const { context, clock, calls } = reading;
  // One announcer, on the page's own frozen clock — the resolution `AppFrame` makes
  // in a window. A second time base here would make "was it said again" a question
  // about the runner rather than about the read.
  const announcer = new LiveAnnouncer({ clock });
  // Under the bridge provider, because the list below this page takes the window's
  // clock from `useConsoleClock` — the console's one answer to which clock a window
  // runs on, and the resolution the provider's own error message says every console
  // surface renders inside. The supplied bridge is the context's, so nothing about
  // what this case answers moves.
  const { container } = render(
    <DesktopBridgeProvider bridge={context.bridge}>
      <LiveAnnouncerProvider announcer={announcer}>
        <WorkspaceMountsPage>
          <MountInventoryList
            bridge={context.bridge}
            calls={calls}
            sessionId={SESSION_ID}
            sessionStore={context.retainedSessionStore}
          />
        </WorkspaceMountsPage>
      </LiveAnnouncerProvider>
    </DesktopBridgeProvider>,
  );
  const settle = async (): Promise<void> => {
    await act(async () => {
      clock.advance(PAST_REFRESH_DEBOUNCE_MS);
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    });
  };
  await settle();
  return {
    page: mountsPageOf(container),
    clock,
    politeText: () => politeText(container),
    settle,
  };
}
