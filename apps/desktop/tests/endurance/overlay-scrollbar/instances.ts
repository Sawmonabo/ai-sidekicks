// How many overlay scrollbars a launched window has started, read in the window's own document,
// where the bars draw: the library marks the element it scrolls once a bar has started, and the
// hook marks one whose bar waits for a first interaction or for the window's idle time. Each
// started bar keeps its own observers and two bar elements, and a bar per row or pane would grow
// with the window, which is why the count is the reading.

import type { AppUnderTest } from "../../helpers/electron/harness.js";
import { CONVERSATION_SCROLLER_SELECTOR } from "../workload.js";

/** The library's marker on an element whose bar has started. */
const STARTED_OVERLAY_SELECTOR = "[data-overlayscrollbars-viewport]";

/** The marker on an element whose bar has not started yet. */
const AWAITING_OVERLAY_SELECTOR =
  "[data-overlayscrollbars-initialize]:not([data-overlayscrollbars-viewport])";

/** The most wheel steps a walk takes in either direction before it gives up on an end. */
const WHEEL_STEP_LIMIT = 400;

/** The overlay scrollbars a window holds at one moment. */
export interface OverlayScrollbarCensus {
  /** Each started bar's element, by tag and classes, for the printed reading. */
  readonly startedHosts: readonly string[];
  /** Elements whose bar has not started. */
  readonly awaitingCount: number;
}

/** What one wheel walk over the conversation saw. */
export interface ConversationWheelWalk {
  /** Wheel steps taken from the first row to the last. */
  readonly stepCount: number;
  /** The most bars started in the window after any one step. */
  readonly peakStartedCount: number;
  /** Every element whose bar had started at any step. */
  readonly startedHosts: readonly string[];
}

/** The overlay scrollbars in the window's document now. */
export async function readOverlayScrollbars(
  appUnderTest: AppUnderTest,
): Promise<OverlayScrollbarCensus> {
  return await appUnderTest.window.evaluate(
    ([startedSelector, awaitingSelector]: [string, string]) => ({
      startedHosts: Array.from(
        document.querySelectorAll(startedSelector),
        (host) => `${host.localName}${Array.from(host.classList, (name) => `.${name}`).join("")}`,
      ),
      awaitingCount: document.querySelectorAll(awaitingSelector).length,
    }),
    [STARTED_OVERLAY_SELECTOR, AWAITING_OVERLAY_SELECTOR] as [string, string],
  );
}

/**
 * Wheels the conversation to its first row, then down to its last half a screen at a time with
 * the pointer resting over it, reading the started bars after each step's frame has painted.
 * Throws when the conversation does not scroll, since a walk over nothing mounts no row.
 */
export async function walkConversationByWheel(
  appUnderTest: AppUnderTest,
): Promise<ConversationWheelWalk> {
  const page = appUnderTest.window;
  const box = await page.locator(CONVERSATION_SCROLLER_SELECTOR).boundingBox();
  if (box === null) {
    throw new Error(`${CONVERSATION_SCROLLER_SELECTOR} has no box to wheel over`);
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const geometry = await readGeometry(appUnderTest);
  if (geometry.scrollHeight <= geometry.clientHeight) {
    throw new Error(
      `the conversation shows all ${String(geometry.scrollHeight)} px it holds, so no wheel walk ` +
        "would mount or unmount a row",
    );
  }
  for (
    let step = 0;
    step < WHEEL_STEP_LIMIT && (await readGeometry(appUnderTest)).scrollTop > 0;
    step += 1
  ) {
    await page.mouse.wheel(0, -geometry.clientHeight);
    await afterPaint(appUnderTest);
  }
  let stepCount = 0;
  let peakStartedCount = 0;
  const startedHosts = new Set<string>();
  for (; stepCount < WHEEL_STEP_LIMIT; stepCount += 1) {
    await page.mouse.wheel(0, geometry.clientHeight / 2);
    await afterPaint(appUnderTest);
    const census = await readOverlayScrollbars(appUnderTest);
    peakStartedCount = Math.max(peakStartedCount, census.startedHosts.length);
    for (const host of census.startedHosts) {
      startedHosts.add(host);
    }
    const now = await readGeometry(appUnderTest);
    if (now.scrollTop + now.clientHeight >= now.scrollHeight - 1) {
      break;
    }
  }
  return { stepCount: stepCount + 1, peakStartedCount, startedHosts: [...startedHosts].sort() };
}

/**
 * Starts `count` more bars in the window, each on a planted scroller of its own, for a negative
 * control. Throws when the window has no copy of the library.
 */
export async function plantStartedOverlayScrollbars(
  appUnderTest: AppUnderTest,
  count: number,
): Promise<void> {
  await appUnderTest.window.evaluate((plantedCount: number) => {
    const library = (
      window as unknown as {
        OverlayScrollbarsGlobal?: {
          OverlayScrollbars: (
            target: { target: Element; elements: { viewport: Element } },
            options: object,
          ) => unknown;
        };
      }
    ).OverlayScrollbarsGlobal;
    if (library === undefined) {
      throw new Error("this window loaded no overlay scrollbar library");
    }
    for (let index = 0; index < plantedCount; index += 1) {
      const planted = document.createElement("div");
      planted.style.cssText = "overflow: auto; block-size: 4rem";
      planted.innerHTML = '<div style="block-size: 20rem"></div>';
      document.body.append(planted);
      // Called without options the library only looks an instance up; with them it starts one.
      library.OverlayScrollbars({ target: planted, elements: { viewport: planted } }, {});
    }
  }, count);
}

interface ScrollGeometry {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

async function readGeometry(appUnderTest: AppUnderTest): Promise<ScrollGeometry> {
  return await appUnderTest.window.evaluate((selector: string) => {
    const element = document.querySelector(selector);
    if (element === null) {
      throw new Error(`${selector} is not in the window`);
    }
    return {
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    };
  }, CONVERSATION_SCROLLER_SELECTOR);
}

/** Resolves once two frames have passed, so the step's scroll has laid out and painted. */
async function afterPaint(appUnderTest: AppUnderTest): Promise<void> {
  await appUnderTest.window.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resolve();
          });
        });
      }),
  );
}
