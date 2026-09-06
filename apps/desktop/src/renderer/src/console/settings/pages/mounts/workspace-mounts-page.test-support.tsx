// The mounts page's own harness: a settings context whose wire is a stand-in, and a
// render that settles the two chained reads behind it.
//
// BESIDE `mounts.test-support.ts` RATHER THAN INSIDE IT. That module is the FIXTURE
// vocabulary — mount ids, the two workspace rows, the shapes a read answers with —
// and it is a `.ts` because none of it renders. What is here mounts a React tree and
// holds a live announcer, so it is a `.tsx`, and the two suites that drive this page
// share it rather than each carrying its own copy of a bridge stub whose call arm
// decides what every case in both files is actually asserting against.

import type { RepoMountReadResponse } from "@ai-sidekicks/contracts";
import { act, render } from "@testing-library/react";

import { SidekicksBridgeProvider, createFixtureBridge } from "../../../bridge/index.js";
import {
  unscriptedScenario,
  withDaemonCall,
} from "../../../bridge/fixture/fixture-bridge.test-support.js";
import { ManualClock } from "../../../core/index.js";
import { PAST_REFRESH_DEBOUNCE_MS } from "../../../core/settle.test-support.js";
import { LiveAnnouncer, LiveAnnouncerProvider } from "../../../primitives/index.js";
import { politeText } from "../../../primitives/live-region.test-support.js";
import type { SessionStore } from "../../../store/index.js";
import { frozenClockOf } from "../../frozen-clock.test-support.js";
import { settingsPageContextWith } from "../../settings-page-mount.test-support.js";
import type { SettingsPageContext } from "../../settings-page-registry.js";
import { SESSION_ID, mountReadFor, workspaceListWith } from "./mounts.test-support.js";
import { WorkspaceMountsPage } from "./WorkspaceMountsPage.js";

/**
 * A settings context whose bridge answers the two registered reads on a clock the
 * test owns.
 *
 * THE BRIDGE IS THE SHIPPED FIXTURE WITH ONE ARM REPLACED, not an object shaped like
 * one. It used to be a literal ending `as unknown as SettingsPageContext`, which made
 * this the one of the family's three harnesses a widened `SettingsPageContext` would
 * NOT have failed — the cast answered for every member nobody had written yet. The
 * daemon arm is swapped through `bridge/fixture/fixture-bridge.test-support.ts`'s own
 * `withDaemonCall`, which is the console's one seam for that, and the context is
 * built by the family's one builder.
 *
 * The clock is the fixture engine's, which is where the page looks for one: a fixture
 * bridge supplies the story's clock and a live bridge supplies none, and this test
 * drives the same resolution rather than reaching around it. It is handed back beside
 * the context, because a case that advanced a clock the page was not reading would be
 * asserting about a timer that never fell due.
 */
export function contextReading(options: {
  readonly mountIds: readonly string[];
  readonly mountOverrides?: Readonly<Record<string, Partial<RepoMountReadResponse>>>;
  readonly retainedSessionId?: string | undefined;
  /** The retained session's store, where the window has one open. */
  readonly sessionStore?: SessionStore | undefined;
  /** Counts what the page asked for, so a refresh can be proved rather than assumed. */
  readonly onCall?: (method: string) => void;
  /** Makes the enumerating read reject, which is the list's own refused arm. */
  readonly rejectWith?: { readonly code: string; readonly message: string };
  /**
   * How many daemon calls `rejectWith` covers. Unbounded when omitted.
   *
   * A bounded count is what drives RECOVERY: a refusal that clears is a first
   * attempt that fails and a second that answers, and a bridge that refused forever
   * could not tell a permanent refusal apart from a transient one.
   */
  readonly rejectionCount?: number;
}): { readonly context: SettingsPageContext; readonly clock: ManualClock } {
  let refusedCallCount = 0;
  const fixture = createFixtureBridge({ scenario: unscriptedScenario("workspace-mounts-page") });
  const clock = frozenClockOf(fixture);
  const { bridge } = withDaemonCall(fixture, async (recorded) => {
    options.onCall?.(recorded.method);
    if (
      options.rejectWith !== undefined &&
      refusedCallCount < (options.rejectionCount ?? Number.POSITIVE_INFINITY)
    ) {
      refusedCallCount += 1;
      // A wire ENVELOPE and not a bare `Error`: the call door normalizes a
      // rejection into the console's refusal shape, and only an envelope
      // carries a code of its own for it to keep. A bare message would be
      // normalized under the door's own code, which is a different assertion.
      throw options.rejectWith;
    }
    if (recorded.method === "repo.workspaceList") {
      return workspaceListWith(options.mountIds);
    }
    const { repoMountId } = recorded.params as { repoMountId: string };
    return mountReadFor(repoMountId, options.mountOverrides?.[repoMountId] ?? {});
  });
  return {
    context: settingsPageContextWith(
      bridge,
      "retainedSessionId" in options ? options.retainedSessionId : SESSION_ID,
      options.sessionStore,
    ),
    clock,
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
}): Promise<{
  readonly page: HTMLElement;
  readonly clock: ManualClock;
  readonly politeText: () => string;
  readonly settle: () => Promise<void>;
}> {
  const { context, clock } = reading;
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
    <SidekicksBridgeProvider bridge={context.bridge}>
      <LiveAnnouncerProvider announcer={announcer}>
        <WorkspaceMountsPage context={context} />
      </LiveAnnouncerProvider>
    </SidekicksBridgeProvider>,
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
