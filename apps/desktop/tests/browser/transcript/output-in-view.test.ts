// A command output the band above the box is still parsing in turn, brought into the box by one
// write to the offset, is drawn whole in the frame that shows it, in the engine that lays the rows
// out and paints them. The write stands in for a measurement above the reader moving the offset:
// the rows a frame draws are read from the offset, whatever moved it.

import { act, fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CONTENT_PAYLOAD_PLAINTEXT_MAX } from "@ai-sidekicks/contracts/event/declared-variants";

import {
  openPagedSessionStore,
  pagedSessionEventAt,
} from "#renderer/features/transcript/logs.test-support.js";
import type { ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";
import { letFramesPass } from "../../helpers/animation-frame.js";
import { readerScrollsTo } from "../../helpers/transcript/reader-scroll.js";
import { ESCAPE, coloredOutputEventAt } from "./colored-output-event.js";
import { FEED_HEIGHT_PX, ROW_SELECTOR, mountTranscriptFeed } from "./long-tool-feed.js";
import { PaintedFrameReader } from "./painted-frames.js";
import { unfilledHeightPx } from "./unfilled-box.js";

/** The log: a call with a long colored output at every position but the last two messages. */
const LOG_ROW_COUNT = 40;
/** The write that moves the offset toward the head by half a screen. */
const OFFSET_MOVE_PX = FEED_HEIGHT_PX / 2;
/** The frames watched after the write, past the band's parses landing. */
const WATCHED_FRAME_COUNT = 20;

/** What a painted frame shows: the height no row covers, and the outputs drawn as their source. */
interface OutputFrame {
  readonly unfilledPx: number;
  readonly sourceOutputCount: number;
}

/** The log's event at `index`: a call's long colored output, or one of the two last messages. */
function eventAt(index: number): ProjectedSessionEvent {
  return index < LOG_ROW_COUNT - 2
    ? coloredOutputEventAt(index, CONTENT_PAYLOAD_PLAINTEXT_MAX)
    : pagedSessionEventAt(index);
}

/** The frame as laid out: how much of the box no row covers, and the outputs not yet formatted. */
function readOutputFrame(scroller: HTMLElement): OutputFrame {
  const sourceOutputs = [...scroller.querySelectorAll(".meridian-ansi__body")].filter((output) =>
    output.textContent.includes(ESCAPE),
  );
  return { unfilledPx: unfilledHeightPx(scroller), sourceOutputCount: sourceOutputs.length };
}

/** Where the first drawn row's top stands below the box's top, and its place in the list. */
function firstDrawnRow(scroller: HTMLElement): { readonly topPx: number; readonly place: number } {
  const boxTopPx = scroller.getBoundingClientRect().top;
  const [first] = [...scroller.querySelectorAll(ROW_SELECTOR)]
    .map((row) => ({
      topPx: row.getBoundingClientRect().top - boxTopPx,
      place: Number(row.getAttribute("aria-posinset")),
    }))
    .sort((upper, lower) => upper.topPx - lower.topPx);
  return first ?? expect.fail("the feed draws a row");
}

describe("an output the band is still parsing, brought into the box by a write to the offset", () => {
  it("is drawn formatted in the frame that shows it, the box never left unfilled", async () => {
    const { scroller } = await mountTranscriptFeed(
      openPagedSessionStore(0, LOG_ROW_COUNT - 1, undefined, eventAt),
      undefined,
    );
    const painted: OutputFrame[] = [];
    const frames = new PaintedFrameReader(
      ROW_SELECTOR,
      () => readOutputFrame(scroller),
      (frame) => {
        painted.push(frame);
      },
    );
    // Both moves in one task, so no parse in turn runs between them. A screen toward the head as
    // the reader scrolls brings the rows a screen above the new box within the band's reach, each
    // output waiting its turn to parse, and held out of the list meanwhile.
    act(() => {
      readerScrollsTo(scroller, scroller.scrollTop - FEED_HEIGHT_PX);
    });
    // The row above the first drawn one is held out, and the write brings its place into the box.
    const first = firstDrawnRow(scroller);
    expect(first.place).toBeGreaterThan(1);
    expect(first.topPx + OFFSET_MOVE_PX).toBeGreaterThan(0);
    act(() => {
      scroller.scrollTop -= OFFSET_MOVE_PX;
      fireEvent.scroll(scroller);
    });
    await letFramesPass(WATCHED_FRAME_COUNT);
    frames.stop();

    expect(painted.length).toBeGreaterThan(0);
    expect(painted.filter((frame) => frame.unfilledPx > 0 || frame.sourceOutputCount > 0)).toEqual(
      [],
    );
  });
});
