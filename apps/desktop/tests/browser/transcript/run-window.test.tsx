// A long run's window in the engine that lays the rows out: its rows sit in the transcript's own
// list with no scroller of their own, and a press on an edge line brings the next stretch while
// the call beside the edge stays where the reader saw it. A DOM shim lays nothing out and never
// moves the scroll position, so a held call there stays put with or without the hold.
//
// The pane is mounted the way the accessibility tier mounts it, with the real row renderer, over a
// store holding one run long enough that its window leaves calls out at both ends after a press.

import { beforeEach, describe, expect, it } from "vitest";

import { changeLayout } from "../../helpers/animation-frame.js";
import { readerScrollsTo } from "./reader-scroll.js";
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
import { openSessionStoreWithLongRun } from "#renderer/features/transcript/runs/call-window.test-support.js";
import { ManualClock } from "#renderer/lib/clock.js";
import { WINDOWED_ROW_INDEX_ATTRIBUTE } from "#renderer/lib/windowed-row-markers.js";
import { createFixtureBridge } from "#renderer/services/platform/bridge.fixture.js";

/** The pane's box: a small share of the run's window, so the transcript scrolls. */
const PANE_HEIGHT_PX = 480;

/** Events in the run: far more calls than its window holds. */
const LONG_RUN_EVENT_COUNT = 900;

/** How far a held call may land from where it stood and still be the same place. */
const HELD_TOLERANCE_PX = 1;

/** The mounted pane, and the scroll container a case scrolls and measures against. */
interface MountedPane {
  readonly pane: HTMLElement;
  readonly scrollContainer: HTMLElement;
}

async function mountPane(): Promise<MountedPane> {
  const sessionStore = openSessionStoreWithLongRun(LONG_RUN_EVENT_COUNT);
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
  // The rows measure, the window is cut in their heights, and the list lands on its tail.
  await changeLayout(() => undefined);
  await changeLayout(() => undefined);
  const scrollContainer = container.querySelector<HTMLElement>(
    ".meridian-transcript-viewport__scroll-container",
  );
  if (scrollContainer === null) {
    throw new Error("the pane rendered no scroll container");
  }
  return { pane: container, scrollContainer };
}

/** The mounted edge line reading `edge`, refusing rather than null. */
function edgeLine(pane: HTMLElement, edge: "earlier" | "later"): HTMLButtonElement {
  const line = [...pane.querySelectorAll<HTMLButtonElement>(".meridian-run-window-edge")].find(
    (button) => (button.textContent ?? "").endsWith(edge),
  );
  if (line === undefined) {
    throw new Error(`the pane drew no edge line reading ${edge}`);
  }
  return line;
}

/** The calls an edge line counts, read off its text. */
function edgeCount(pane: HTMLElement, edge: "earlier" | "later"): number {
  const count = /(\d[\d,]*) /u.exec(edgeLine(pane, edge).textContent ?? "")?.[1];
  return Number((count ?? "").replaceAll(",", ""));
}

/** The list row `offset` rows from the row holding an edge line. */
function rowBeside(pane: HTMLElement, edge: "earlier" | "later", offset: number): HTMLElement {
  const edgeRow = edgeLine(pane, edge).closest<HTMLElement>(`[${WINDOWED_ROW_INDEX_ATTRIBUTE}]`);
  const edgeIndex = Number(edgeRow?.getAttribute(WINDOWED_ROW_INDEX_ATTRIBUTE));
  const beside = pane.querySelector<HTMLElement>(
    `[${WINDOWED_ROW_INDEX_ATTRIBUTE}="${String(edgeIndex + offset)}"]`,
  );
  if (edgeRow === null || beside === null) {
    throw new Error(`the list mounted no row beside the ${edge} edge`);
  }
  return beside;
}

/**
 * The one mounted list row whose text is `text`: the same call after a press, since the list may
 * draw it in a new element.
 */
function rowReading(pane: HTMLElement, text: string): HTMLElement {
  const rows = [...pane.querySelectorAll<HTMLElement>(`[${WINDOWED_ROW_INDEX_ATTRIBUTE}]`)].filter(
    (row) => row.textContent === text,
  );
  if (rows.length !== 1 || rows[0] === undefined) {
    throw new Error(`the list mounted ${String(rows.length)} rows reading ${text}`);
  }
  return rows[0];
}

/** How far below the top of the scroll container an element stands on screen. */
function offsetInBoxPx(mounted: MountedPane, element: HTMLElement): number {
  return element.getBoundingClientRect().top - mounted.scrollContainer.getBoundingClientRect().top;
}

/** Every element inside the list that scrolls on its own. */
function innerScrollers(scrollContainer: HTMLElement): readonly Element[] {
  return [...scrollContainer.querySelectorAll("*")].filter((element) =>
    /auto|scroll/u.test(getComputedStyle(element).overflowY),
  );
}

beforeEach(() => {
  installMeridianTokens(document);
  // The row renderer, registered the way the console registers it; the pane cannot render
  // rows without one.
  registerTranscriptRows();
});

describe("browser — a long run's window", () => {
  it("draws its rows in the list, and holds the call beside a pressed edge", async () => {
    const mounted = await mountPane();
    const { pane, scrollContainer } = mounted;
    expect(scrollContainer.scrollHeight).toBeGreaterThan(scrollContainer.clientHeight);

    // The window opens on the run's newest calls, the earlier edge above them at the top.
    await readerScrollsTo(scrollContainer, 0);
    const earlierBefore = edgeCount(pane, "earlier");
    expect(earlierBefore).toBeGreaterThan(0);
    // The count wears the line's own quiet ink, never a brighter figure color of its own.
    const line = edgeLine(pane, "earlier");
    expect(
      [...line.querySelectorAll("*")].map((element) => getComputedStyle(element).color),
    ).toStrictEqual([...line.querySelectorAll("*")].map(() => getComputedStyle(line).color));
    const besideEarlierText = rowBeside(pane, "earlier", 1).textContent ?? "";
    const besideEarlierOffsetPx = offsetInBoxPx(mounted, rowReading(pane, besideEarlierText));

    await changeLayout(() => {
      edgeLine(pane, "earlier").click();
    });

    // The next stretch landed above the call, and the reader still sees it where it stood.
    expect(scrollContainer.scrollTop).toBeGreaterThan(0);
    expect(
      Math.abs(offsetInBoxPx(mounted, rowReading(pane, besideEarlierText)) - besideEarlierOffsetPx),
    ).toBeLessThanOrEqual(HELD_TOLERANCE_PX);
    await readerScrollsTo(scrollContainer, 0);
    const earlierAfter = edgeCount(pane, "earlier");
    expect(earlierAfter).toBeGreaterThan(0);
    expect(earlierAfter).toBeLessThan(earlierBefore);
    // Read with the edge line and the stretch's first calls mounted.
    expect(innerScrollers(scrollContainer)).toStrictEqual([]);

    // The press left calls out after the window too; the later edge brings them back.
    await readerScrollsTo(
      scrollContainer,
      scrollContainer.scrollHeight - scrollContainer.clientHeight,
    );
    const laterBefore = edgeCount(pane, "later");
    expect(laterBefore).toBeGreaterThan(0);
    const besideLaterText = rowBeside(pane, "later", -1).textContent ?? "";
    const besideLaterOffsetPx = offsetInBoxPx(mounted, rowReading(pane, besideLaterText));

    await changeLayout(() => {
      edgeLine(pane, "later").click();
    });

    expect(
      Math.abs(offsetInBoxPx(mounted, rowReading(pane, besideLaterText)) - besideLaterOffsetPx),
    ).toBeLessThanOrEqual(HELD_TOLERANCE_PX);
  });
});
