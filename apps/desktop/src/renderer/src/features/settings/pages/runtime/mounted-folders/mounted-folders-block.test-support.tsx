// The mounted-folders block's harness: a settings context, the two inventory calls as plain
// stubs, and a render that settles the two chained reads behind them.
//
// Beside `mounted-folders.test-support.ts`, which holds the fixture vocabulary (mount ids,
// workspace rows, read shapes) and renders nothing. This one mounts a React tree with a live
// announcer, so it is a `.tsx`.

import type { RepoMountReadResponse } from "@ai-sidekicks/contracts/repo/folders";
import type { WorkspaceListResponse } from "@ai-sidekicks/contracts/workspace";
import { act, render } from "@testing-library/react";
import { PlatformBridgeProvider } from "@renderer/services/platform/PlatformBridgeProvider.js";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { unscriptedScenario } from "@test/helpers/fixture/bridge.js";
import { ManualClock } from "@renderer/lib/clock.js";
import { PAST_REFRESH_DEBOUNCE_MS } from "@test/helpers/settle.js";
import { LiveAnnouncerProvider } from "@renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { frozenClockOf } from "@test/helpers/scheduled-read.js";
import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import { settingsPageContextWith } from "@test/helpers/settings-page-mount.js";
import type { SettingsPageContext } from "@renderer/features/settings/types.js";
import { SESSION_ID, mountReadFor, workspaceListWith } from "./mounted-folders.test-support.js";
import { MountedFolderList } from "./MountedFolderList.js";
import type { MountInventoryCalls } from "./mount-inventory/mount-inventory.js";
import { MountedFoldersBlock } from "./MountedFoldersBlock.js";

/**
 * A settings context on a clock the test owns, and the two calls the inventory reads
 * through, answered from plain stubs.
 *
 * The bridge is the shipped fixture, where the page looks for its reconnect signal, and the
 * clock is its scenario's frozen one, which the window runs on. The calls are separate
 * because they are an argument of the list, not a bridge method. The clock is returned
 * beside the context because advancing a clock the page is not reading would assert about
 * a timer that never fell due.
 */
export function contextReading(options: {
  readonly mountIds: readonly string[];
  /** Counts what the page asked for, so a refresh can be proved rather than assumed. */
  readonly onCall?: (call: "workspaceList" | "mountRead") => void;
  /** Makes the calls reject with this message, which fails the read. */
  readonly rejectWith?: string;
  /**
   * How many calls `rejectWith` covers. Unbounded when omitted.
   *
   * A bounded count drives recovery: a first attempt that fails and a second that answers.
   */
  readonly rejectionCount?: number;
}): {
  readonly context: SettingsPageContext;
  readonly clock: ManualClock;
  readonly calls: MountInventoryCalls;
} {
  let rejectedCallCount = 0;
  const fixture = createFixtureBridge({ scenario: unscriptedScenario("mounted-folders-block") });
  const clock = frozenClockOf(fixture.scenarioEngine.clock);
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
      return Promise.resolve(mountReadFor(request.repoMountId));
    },
  };
  return {
    context: settingsPageContextWith(fixture.bridge, SESSION_ID),
    clock,
    calls,
  };
}

/**
 * Mount, advance past the coalescing window, and let the two chained reads settle.
 *
 * The read is the real one; only the wire is a stand-in. Settling is one macrotask turn,
 * not a counted run of microtask flushes, because a fan-out's tick count depends on how
 * many mounts the fixture named.
 */
export async function renderSettledBlock(reading: {
  readonly context: SettingsPageContext;
  readonly clock: ManualClock;
  readonly calls: MountInventoryCalls;
}): Promise<{ readonly page: HTMLElement; readonly settle: () => Promise<void> }> {
  const { context, clock, calls } = reading;
  // Under the bridge provider, because the list takes the window's clock from `useClock`.
  // The bridge is the context's and the clock the case's.
  const { container } = render(
    <PlatformBridgeProvider bridge={context.bridge} clock={clock}>
      <LiveAnnouncerProvider>
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
      await crossMacrotaskBoundary();
    });
  };
  await settle();
  return { page: mountedFoldersBlockOf(container), settle };
}

/** The block's own element, so a case never reads the announcer's regions by accident. */
function mountedFoldersBlockOf(root: HTMLElement): HTMLElement {
  const block = root.querySelector<HTMLElement>('section[aria-label="Mounted repositories"]');
  if (block === null) {
    throw new Error("the mounted-folders block did not render");
  }
  return block;
}
