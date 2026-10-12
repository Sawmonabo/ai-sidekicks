// The transcript's follow of the bottom held while a person drags a pane edge, through the real
// pane layout around the real transcript feed and the browser's own mouse: rows appended with the
// edge held leave the transcript's offset where it was, and on release the transcript lands on
// its last row again. The same append with no edge held follows at once: the negative control.

import { act } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { letFramesPass } from "../../helpers/animation-frame.js";
import { bridgeWrapper } from "../../helpers/app/frame-fixtures.js";
import { renderSettled } from "../../helpers/app/harness.js";
import { layoutPaneContext } from "../../helpers/pane-context.js";
import { RealMouse } from "../real-mouse.js";

import { installMeridianTokens } from "#renderer/app/token-installation.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { PaneFrame } from "#renderer/components/PaneFrame/PaneFrame.js";
import { SessionPaneLayout } from "#renderer/features/sessions/pane-layout/components/SessionPaneLayout.js";
import { PaneLayoutStore } from "#renderer/features/sessions/pane-layout/store.js";
import { TranscriptFeed } from "#renderer/features/transcript/feed/components/TranscriptFeed.js";
import {
  openSessionStoreWithToolRows,
  toolRowEventAt,
} from "#renderer/features/transcript/logs.test-support.js";
import { prepareTranscriptRow } from "#renderer/features/transcript/rows/preparation.js";
import {
  TranscriptRow,
  drawsTranscriptRowBody,
} from "#renderer/features/transcript/rows/TranscriptRow.js";
import { PaneRegistry } from "#renderer/registries/panes/registry.js";
import { createFixtureBridge } from "#renderer/services/platform/bridge.fixture.js";
import { type SessionStore } from "#renderer/store/session/store.js";
import { EMPTY_SESSION_SCENARIO } from "#fixtures/scenarios/empty-session.js";

/** The rows the log opens with: several screens of them. */
const OPENING_ROW_COUNT = 80;
/** The rows each append brings. */
const APPENDED_ROW_COUNT = 12;
/** How far the pane edge is dragged, in CSS pixels. */
const DRAG_TRAVEL_PX = 60;
/** The frames an append is given to land, more than a follower takes to reach it. */
const SETTLE_FRAME_COUNT = 12;

let mouse: RealMouse | undefined;
let pressedAt: { readonly x: number; readonly y: number } | undefined;

afterEach(async () => {
  // A case that failed with the button down lets it go, so the next case's mouse starts up.
  if (mouse !== undefined && pressedAt !== undefined) {
    await mouse.release(pressedAt);
  }
  mouse = undefined;
  pressedAt = undefined;
});

describe("browser — the transcript's follow held while a pane edge is dragged", () => {
  it("leaves the offset where it was until release, then follows", async () => {
    const sessionStore = openSessionStoreWithToolRows(OPENING_ROW_COUNT);
    const { scroller, edge } = await mountConversationBesidePreview(sessionStore);
    expect(distanceFromTailPx(scroller)).toBeLessThan(1);

    // Negative control: with no edge held, the append is followed.
    const restingOffsetPx = scroller.scrollTop;
    await appendRows(sessionStore, OPENING_ROW_COUNT);
    expect(scroller.scrollTop).toBeGreaterThan(restingOffsetPx);
    expect(distanceFromTailPx(scroller)).toBeLessThan(1);

    mouse = await RealMouse.calibrated(document);
    const box = edge.getBoundingClientRect();
    const from = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    const to = { x: from.x + DRAG_TRAVEL_PX, y: from.y };
    const heldMouse = mouse;
    await act(async () => {
      await heldMouse.press(from);
      pressedAt = from;
      await heldMouse.dragTo(from, to, 6);
      pressedAt = to;
    });
    await letFramesPass(SETTLE_FRAME_COUNT);
    const heldOffsetPx = scroller.scrollTop;

    await appendRows(sessionStore, OPENING_ROW_COUNT + APPENDED_ROW_COUNT);
    expect(scroller.scrollTop).toBe(heldOffsetPx);
    expect(distanceFromTailPx(scroller)).toBeGreaterThan(1);

    await act(async () => {
      await heldMouse.release(to);
    });
    pressedAt = undefined;
    await letFramesPass(SETTLE_FRAME_COUNT);
    expect(distanceFromTailPx(scroller)).toBeLessThan(1);
  });
});

/**
 * The real transcript feed as the conversation of a pane layout with Preview open beside it, the
 * pane's own edge between them; answers the transcript's scroller and that edge.
 */
async function mountConversationBesidePreview(
  sessionStore: SessionStore,
): Promise<{ readonly scroller: HTMLElement; readonly edge: HTMLElement }> {
  installMeridianTokens(document);
  const fixture = createFixtureBridge({ scenario: EMPTY_SESSION_SCENARIO });
  const registry = new PaneRegistry();
  registry.register({
    kind: "browser",
    owner: "follow-hold-test",
    render: () => <PaneFrame kind="browser" sessionId={undefined} />,
  });
  const layout = new PaneLayoutStore();
  layout.open({ kind: "browser" });
  const BridgeHost = bridgeWrapper(fixture.bridge);
  const { container } = await renderSettled(
    <BridgeHost>
      <LiveAnnouncerProvider>
        <div style={{ display: "grid", height: "600px", width: "1400px" }}>
          <SessionPaneLayout
            layout={layout}
            registry={registry}
            paneContextFor={(pane) =>
              layoutPaneContext(pane, { bridge: fixture.bridge, sessionStore })
            }
            isSessionOpen
            sessionId={undefined}
            conversation={
              <div style={{ display: "grid", height: "100%" }}>
                <TranscriptFeed
                  sessionStore={sessionStore}
                  rowRenderer={{
                    render: TranscriptRow,
                    drawsBody: drawsTranscriptRowBody,
                    prepareRow: prepareTranscriptRow,
                  }}
                  feedLabel="Transcript"
                  readTranscriptPage={undefined}
                  readTranscriptBody={undefined}
                />
              </div>
            }
          />
        </div>
      </LiveAnnouncerProvider>
    </BridgeHost>,
  );
  const viewport =
    container.querySelector(".meridian-transcript-viewport") ??
    expect.fail("the feed draws its viewport");
  // The rows are shown once the faces they draw in have landed.
  await expect
    .poll(async () => {
      await act(async () => {
        await document.fonts.ready;
      });
      return getComputedStyle(viewport).visibility;
    })
    .toBe("visible");
  await letFramesPass(SETTLE_FRAME_COUNT);
  return {
    scroller:
      viewport.querySelector<HTMLElement>(".meridian-transcript-viewport__scroll-container") ??
      expect.fail("the feed draws its scroller"),
    edge:
      container.querySelector<HTMLElement>(".meridian-pane-edge") ??
      expect.fail("Preview draws its edge"),
  };
}

/** Appends tool rows from log position `fromIndex`, as a run streaming its calls does. */
async function appendRows(sessionStore: SessionStore, fromIndex: number): Promise<void> {
  act(() => {
    sessionStore.applyBatch(
      Array.from({ length: APPENDED_ROW_COUNT }, (_unused, offset) =>
        toolRowEventAt(fromIndex + offset),
      ),
    );
  });
  await letFramesPass(SETTLE_FRAME_COUNT);
}

/** How far the scroller stands above its last row. */
function distanceFromTailPx(scroller: HTMLElement): number {
  return scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
}
