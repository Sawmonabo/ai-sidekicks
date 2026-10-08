// Where a press on a run group's header leaves that header, in the engine that lays the rows out.
// A fold or an open changes the height of the rows under the header, and the list's anchor at
// its end moves the scroll position when the reader follows the tail; a DOM shim lays nothing
// out and never moves the scroll position, so a header there stays put with or without the hold.
//
// The pane is mounted the way the accessibility tier mounts it, with the real row renderer, over
// a store holding an ended run and a live run among messages, or with the live run ending the log.

import { fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { changeLayout } from "../../helpers/animation-frame.js";
import { FixtureBridgeProvider } from "../../helpers/app/frame-fixtures.js";
import { renderSettled } from "../../helpers/app/harness.js";

import { EMPTY_SESSION_SCENARIO } from "#fixtures/scenarios/empty-session.js";
import { installMeridianTokens } from "#renderer/app/token-installation.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
// Imported deeply, not through the feature's `index.ts`: widening the public entry for one test
// would be wrong.
import { registerTranscriptRows } from "#renderer/features/transcript/contributions/rows.js";
import { SessionScreenContainer } from "#renderer/features/transcript/SessionScreenContainer.js";
import { TranscriptPane } from "#renderer/features/transcript/TranscriptPane.js";
import { transcriptPaneContext } from "#renderer/features/transcript/TranscriptPane.test-support.js";
import { SESSION_ID } from "#renderer/features/transcript/logs.test-support.js";
import {
  openSessionStoreWithLiveRunAtTail,
  openSessionStoreWithRunsAmongMessages,
} from "#renderer/features/transcript/runs/groups.logs.test-support.js";
import { ManualClock } from "#renderer/lib/clock.js";
import { createFixtureBridge } from "#renderer/services/platform/bridge.fixture.js";
import type { SessionStore } from "#renderer/store/session/store.js";

/** The pane's box: shorter than the log's rows, so the transcript scrolls. */
const PANE_HEIGHT_PX = 480;

/** How far a held header may land from where it stood and still be the same place. */
const HELD_TOLERANCE_PX = 1;

/** The disclosure button every run group header draws, whose box a case reads. */
const RUN_GROUP_HEADER_BUTTON = ".meridian-run-group-header__disclosure";

/** How far above the bottom of the box a case stands a header before folding its group. */
const HEADER_ABOVE_BOX_BOTTOM_PX = 40;

/** The mounted pane, and the scroll container a case scrolls and measures against. */
interface MountedPane {
  readonly pane: HTMLElement;
  readonly scrollContainer: HTMLElement;
}

/** Mounts the transcript pane in a fixed box over one store's log, opened at its tail. */
async function mountPane(sessionStore: SessionStore): Promise<MountedPane> {
  const { container } = await renderSettled(
    <FixtureBridgeProvider fixture={createFixtureBridge({ scenario: EMPTY_SESSION_SCENARIO })}>
      <LiveAnnouncerProvider clock={new ManualClock()}>
        <div style={{ display: "grid", height: `${String(PANE_HEIGHT_PX)}px` }}>
          <SessionScreenContainer>
            <TranscriptPane context={transcriptPaneContext(sessionStore, SESSION_ID)} />
          </SessionScreenContainer>
        </div>
      </LiveAnnouncerProvider>
    </FixtureBridgeProvider>,
  );
  // The rows measure and the list lands on its tail once the observers answer.
  await changeLayout(() => undefined);
  const scrollContainer = container.querySelector<HTMLElement>(
    ".meridian-transcript-viewport__scroll-container",
  );
  if (scrollContainer === null) {
    throw new Error("the pane rendered no scroll container");
  }
  return { pane: container, scrollContainer };
}

/** The header button of the run whose newest state is `runState`, if the list mounted it. */
function mountedHeaderButtonOf(pane: HTMLElement, runState: string): HTMLButtonElement | undefined {
  return [...pane.querySelectorAll<HTMLButtonElement>(RUN_GROUP_HEADER_BUTTON)].find((button) =>
    (button.textContent ?? "").includes(runState),
  );
}

/** The header button of the run whose newest state is `runState`, refusing rather than null. */
function headerButtonOf(pane: HTMLElement, runState: string): HTMLButtonElement {
  const header = mountedHeaderButtonOf(pane, runState);
  if (header === undefined) {
    throw new Error(`the pane drew no run group header reading ${runState}`);
  }
  return header;
}

/** How far below the top of the scroll container a run's header stands on screen. */
function headerOffsetPx(mounted: MountedPane, runState: string): number {
  return (
    headerButtonOf(mounted.pane, runState).getBoundingClientRect().top -
    mounted.scrollContainer.getBoundingClientRect().top
  );
}

/** Scrolls the box as a reader does, and lets the list follow. */
async function readerScrollsTo(scrollContainer: HTMLElement, scrollTopPx: number): Promise<void> {
  await changeLayout(() => {
    scrollContainer.scrollTop = scrollTopPx;
    fireEvent.scroll(scrollContainer);
  });
}

/** Presses a run's header, and lets the fold lay out and the hold land. */
async function pressHeader(mounted: MountedPane, runState: string): Promise<void> {
  await changeLayout(() => {
    headerButtonOf(mounted.pane, runState).click();
  });
}

beforeEach(() => {
  installMeridianTokens(document);
  // The row renderer, registered the way the console registers it; the pane cannot render
  // rows without one.
  registerTranscriptRows();
});

describe("browser — a press on a run group header holds the header where it stood", () => {
  it("folds an ended and a live group, each header where it stood", async () => {
    const mounted = await mountPane(openSessionStoreWithRunsAmongMessages());
    const { scrollContainer } = mounted;
    // The control: a box that does not scroll has no scroll position for a hold to move.
    expect(scrollContainer.scrollHeight).toBeGreaterThan(scrollContainer.clientHeight);

    for (const runState of ["run.completed", "run.running"]) {
      // The list mounts only the rows near the view, so the reader scrolls down from the top until
      // the header is drawn.
      await readerScrollsTo(scrollContainer, 0);
      while (mountedHeaderButtonOf(mounted.pane, runState) === undefined) {
        const scrollTopBeforePx = scrollContainer.scrollTop;
        await readerScrollsTo(
          scrollContainer,
          scrollTopBeforePx + scrollContainer.clientHeight / 2,
        );
        if (scrollContainer.scrollTop === scrollTopBeforePx) {
          throw new Error(`the list drew no header reading ${runState} anywhere in the box`);
        }
      }
      // Near the bottom of the box, so the rows left below a folded header still fill it and the
      // scroll position a hold asks for is one the box can take.
      const header = headerButtonOf(mounted.pane, runState);
      const headerTopInContentPx =
        header.getBoundingClientRect().top -
        scrollContainer.getBoundingClientRect().top +
        scrollContainer.scrollTop;
      const boxBottomPx = scrollContainer.clientHeight - HEADER_ABOVE_BOX_BOTTOM_PX;
      await readerScrollsTo(scrollContainer, Math.max(0, headerTopInContentPx - boxBottomPx));
      expect(headerButtonOf(mounted.pane, runState).getAttribute("aria-expanded")).toBe("true");
      const offsetBeforePx = headerOffsetPx(mounted, runState);

      await pressHeader(mounted, runState);

      expect(headerButtonOf(mounted.pane, runState).getAttribute("aria-expanded")).toBe("false");
      expect(Math.abs(headerOffsetPx(mounted, runState) - offsetBeforePx)).toBeLessThanOrEqual(
        HELD_TOLERANCE_PX,
      );
    }
  });

  it("opens the group ending the log at the tail with its header where it stood", async () => {
    const mounted = await mountPane(openSessionStoreWithLiveRunAtTail());
    const { scrollContainer } = mounted;
    await pressHeader(mounted, "run.running");
    await readerScrollsTo(
      scrollContainer,
      scrollContainer.scrollHeight - scrollContainer.clientHeight,
    );
    // The control: the reader stands at the tail, where the list follows it.
    expect(
      scrollContainer.scrollHeight - scrollContainer.clientHeight - scrollContainer.scrollTop,
    ).toBeLessThanOrEqual(HELD_TOLERANCE_PX);
    expect(scrollContainer.scrollTop).toBeGreaterThan(0);
    const offsetAtTailPx = headerOffsetPx(mounted, "run.running");
    const scrollHeightFoldedPx = scrollContainer.scrollHeight;

    // The open lays the group's rows out below its header at the end of the log; the list's anchor
    // at its end would lift the header by their height, and the press holds it instead.
    await pressHeader(mounted, "run.running");

    expect(headerButtonOf(mounted.pane, "run.running").getAttribute("aria-expanded")).toBe("true");
    // The control: the open grew the list, so the end anchor had height to lift the header by.
    expect(scrollContainer.scrollHeight).toBeGreaterThan(scrollHeightFoldedPx);
    expect(Math.abs(headerOffsetPx(mounted, "run.running") - offsetAtTailPx)).toBeLessThanOrEqual(
      HELD_TOLERANCE_PX,
    );
  });
});
