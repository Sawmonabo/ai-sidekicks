// The width a transcript's rows are laid out at, as a row not yet listed is laid out at it: before
// any row is measured it is read from the scroll container, and it must be the width the rows then
// take, to the subpixel, or a table measured off the list wraps its cells at another width.

import { act } from "@testing-library/react";
import { useLayoutEffect, useState } from "react";
import { describe, expect, it } from "vitest";

import { renderSettled } from "../../helpers/app/harness.js";
import { liveBridgeWrapper } from "../../helpers/app/frame-fixtures.js";
import { nextFrame } from "../../helpers/animation-frame.js";

import { installMeridianTokens } from "#renderer/app/token-installation.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { TranscriptViewport } from "#renderer/features/transcript/viewport/components/TranscriptViewport.js";
import {
  CALM,
  syntheticRows,
} from "#renderer/features/transcript/viewport/controller.test-support.js";
import {
  useTranscriptViewport,
  type TranscriptViewportBinding,
} from "#renderer/features/transcript/viewport/hooks/useTranscriptViewport.js";
import { ManualClock } from "#renderer/lib/clock.js";

/** A pane width off the pixel grid, as a split pane's share often is. */
const PANE_WIDTH_PX = 700.5;
const PANE_HEIGHT_PX = 400;
const ROWS = syntheticRows(20);

/** The viewport, its width read once its scroll container is attached, before any row measures. */
function ViewportUnderTest(props: {
  readonly onRead: (binding: TranscriptViewportBinding, widthPx: number | undefined) => void;
}): React.JSX.Element {
  const [clock] = useState(() => new ManualClock());
  const binding = useTranscriptViewport({ clock, rows: ROWS, ...CALM });
  const [hasRead, setHasRead] = useState(false);
  const { onRead } = props;
  useLayoutEffect(() => {
    if (!hasRead) {
      setHasRead(true);
      onRead(binding, binding.readRowWidthPx());
    }
  }, [binding, hasRead, onRead]);
  return (
    <TranscriptViewport
      binding={binding}
      renderRow={(row) => <div style={{ height: "24px" }}>{row.key}</div>}
      feedLabel="Transcript"
      firstReadSettled
      isShown
    />
  );
}

describe("the width a transcript's rows are laid out at", () => {
  it("reads, before any row is measured, the width the rows then take", async () => {
    installMeridianTokens(document);
    let binding: TranscriptViewportBinding | undefined;
    let widthBeforeRowsPx: number | undefined;
    const Wrapper = liveBridgeWrapper();
    const { container } = await renderSettled(
      <Wrapper>
        <LiveAnnouncerProvider>
          <div
            style={{
              display: "grid",
              width: `${String(PANE_WIDTH_PX)}px`,
              height: `${String(PANE_HEIGHT_PX)}px`,
            }}
          >
            <ViewportUnderTest
              onRead={(read, widthPx) => {
                binding = read;
                widthBeforeRowsPx = widthPx;
              }}
            />
          </div>
        </LiveAnnouncerProvider>
      </Wrapper>,
    );
    await act(async () => {
      await nextFrame();
      await nextFrame();
    });
    const row = container.querySelector(".meridian-transcript-viewport__row");
    const rowWidthPx = row?.getBoundingClientRect().width ?? expect.fail("a row is listed");
    expect(rowWidthPx).not.toBe(Math.round(rowWidthPx));
    expect(widthBeforeRowsPx).toBeCloseTo(rowWidthPx, 3);
    // Measured, the rows declare that same width.
    expect(binding?.readRowWidthPx()).toBeCloseTo(rowWidthPx, 3);
  });
});
