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
import { PlatformBridgeProvider } from "@renderer/services/platform/PlatformBridgeProvider.js";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { unscriptedScenario } from "@test/helpers/fixture-bridge.js";
import { ManualClock } from "@renderer/lib/clock.js";
import { PAST_REFRESH_DEBOUNCE_MS } from "@test/helpers/settle.js";
import { LiveAnnouncer, LiveAnnouncerProvider } from "@renderer/console/primitives/index.js";
import { politeText } from "@test/helpers/live-region.js";
import type { SessionStore } from "@renderer/store/session/session-store.js";
import { frozenClockOf } from "@test/helpers/scheduled-read.js";
import { settingsPageContextWith } from "@test/helpers/settings-page-mount.js";
import type { SettingsPageContext } from "../../../types.js";
import { SESSION_ID, mountReadFor, workspaceListWith } from "./mounted-folders.test-support.js";
import { MountedFolderList } from "./MountedFolderList.js";
import type { MountInventoryCalls } from "./mount-inventory.js";
import { MountedFoldersBlock } from "./MountedFoldersBlock.js";

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

/** The block's own element, so a case never reads the announcer's regions by accident. */
export function mountedFoldersBlockOf(root: HTMLElement): HTMLElement {
  const block = root.querySelector<HTMLElement>('section[aria-label="Mounted repositories"]');
  if (block === null) {
    throw new Error("the mounted-folders block did not render");
  }
  return block;
}

/**
 * Mount, advance past the coalescing window, and let the two chained reads settle.
 *
 * The read itself is the real one and only the wire is a stand-in. Settling is one
 * turn of the macrotask queue rather than a counted run of microtask flushes,
 * because the number of ticks a fan-out takes is a function of how many mounts the
 * fixture named.
 */
export async function renderSettledBlock(reading: {
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
  // clock from `useClock` — the console's one answer to which clock a window
  // runs on, and the resolution the provider's own error message says every console
  // surface renders inside. The supplied bridge is the context's, so nothing about
  // what this case answers moves.
  const { container } = render(
    <PlatformBridgeProvider bridge={context.bridge}>
      <LiveAnnouncerProvider announcer={announcer}>
        <MountedFoldersBlock>
          <MountedFolderList
            bridge={context.bridge}
            calls={calls}
            sessionId={SESSION_ID}
            sessionStore={context.retainedSessionStore}
          />
        </MountedFoldersBlock>
      </LiveAnnouncerProvider>
    </PlatformBridgeProvider>,
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
    page: mountedFoldersBlockOf(container),
    clock,
    politeText: () => politeText(container),
    settle,
  };
}
