// What the viewport draws and refuses to mount. `happy-dom` answers zero for every geometry read,
// so geometry-dependent states (the tail pill, the anchor holding across an append) are asserted in
// `reading-anchor.test.ts` and `features/transcript/viewport/controller.test.ts`. Here: the feed is
// named, only a slice of the log is in the document, a settled viewport has no timer armed, and
// mounting rows reads no selection.
// `withLaidOutViewport` stands in for the layout engine only; every module in the assertion path is
// the shipped one.

import { act, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ManualClock, type Clock } from "#renderer/lib/clock.js";
import { TranscriptViewport } from "./TranscriptViewport.js";
import {
  useTranscriptViewport,
  type TranscriptViewportBinding,
} from "../hooks/useTranscriptViewport.js";
import type { ViewportRow } from "../snapshot.js";
import { CALM, syntheticRows, withLaidOutViewport } from "../controller.test-support.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { spiedAnnouncer } from "#test/helpers/spied-announcer.js";

const LONG_LOG_ROW_COUNT = 500;

/** A log long enough to scroll its first row out of sight, short enough for the window to hold. */
const HELD_LOG_ROW_COUNT = 200;

interface BindingHolder {
  binding: TranscriptViewportBinding | undefined;
}

interface ComposedTranscriptViewportProps {
  readonly clock: Clock;
  readonly rows: readonly ViewportRow[];
  readonly renderRow: (row: ViewportRow) => React.ReactNode;
  readonly feedLabel: string;
  /** Filled on every commit, so a case can act on the binding the viewport got. */
  readonly holder?: BindingHolder;
}

/**
 * The composition every viewport caller performs: mint one binding, hand it down. The viewport
 * does not mint its own, so rendering it bare would assert against an unrenderable component.
 */
function ComposedTranscriptViewport(props: ComposedTranscriptViewportProps): React.JSX.Element {
  const binding = useTranscriptViewport({
    clock: props.clock,
    rows: props.rows,
    ...CALM,
  });
  const { holder } = props;
  useEffect(() => {
    if (holder !== undefined) {
      holder.binding = binding;
    }
  });
  return (
    <TranscriptViewport
      binding={binding}
      renderRow={props.renderRow}
      feedLabel={props.feedLabel}
      firstReadSettled
    />
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

function renderRow(row: ViewportRow): React.ReactNode {
  return <p>{row.key}</p>;
}

describe("the transcript viewport — the feed", () => {
  it("names the feed, and mounts far fewer rows than the log holds", () => {
    withLaidOutViewport({ content: "none" });
    const { container } = render(
      <ComposedTranscriptViewport
        clock={new ManualClock()}
        rows={syntheticRows(LONG_LOG_ROW_COUNT)}
        renderRow={renderRow}
        feedLabel="Transcript"
      />,
      { wrapper: LiveAnnouncerProvider },
    );
    expect(screen.getByRole("feed", { name: "Transcript" })).toBeDefined();
    const mounted = container.querySelectorAll(".meridian-transcript-viewport__row");
    expect(mounted.length).toBeGreaterThan(0);
    expect(mounted.length).toBeLessThan(LONG_LOG_ROW_COUNT / 4);
  });

  it("mounts its rows without reading the selection, behind one selection listener", () => {
    withLaidOutViewport({ content: "none" });
    // React puts its own `selectionchange` listener on the document with the first root it makes,
    // so one root goes up first and the count below is the transcript's alone.
    render(<p />);
    const addEventListener = vi.spyOn(document, "addEventListener");
    const getSelection = vi.spyOn(document, "getSelection");
    const { container } = render(
      <ComposedTranscriptViewport
        clock={new ManualClock()}
        rows={syntheticRows(LONG_LOG_ROW_COUNT)}
        renderRow={renderRow}
        feedLabel="Transcript"
      />,
      { wrapper: LiveAnnouncerProvider },
    );
    expect(container.querySelectorAll(".meridian-transcript-viewport__row").length).toBeGreaterThan(
      1,
    );
    expect(getSelection).not.toHaveBeenCalled();
    const selectionListeners = addEventListener.mock.calls.filter(
      ([type]) => type === "selectionchange",
    );
    expect(selectionListeners).toHaveLength(1);
  });

  it("arms no timer once the first paint has settled", () => {
    withLaidOutViewport({ content: "none" });
    const clock = new ManualClock();
    render(
      <ComposedTranscriptViewport
        clock={clock}
        rows={syntheticRows(20)}
        renderRow={renderRow}
        feedLabel="Transcript"
      />,
      { wrapper: LiveAnnouncerProvider },
    );
    // Row measurements coalesce onto one frame and the drawn band widens over the tasks after it;
    // after that a quiet viewport holds nothing armed.
    for (let pass = 0; pass < 4; pass += 1) {
      clock.runFrame();
      act(() => {
        clock.advance(0);
      });
    }
    expect(clock.pendingCount).toBe(0);
  });

  it("draws both rows of a projection that repeated a key", () => {
    withLaidOutViewport({ content: "none" });
    const rows: readonly ViewportRow[] = [
      { key: "row-0", parentKey: undefined, rootCursor: "cursor-0" },
      { key: "row-0", parentKey: undefined, rootCursor: "cursor-1" },
    ];
    const { container } = render(
      <ComposedTranscriptViewport
        clock={new ManualClock()}
        rows={rows}
        renderRow={renderRow}
        feedLabel="Transcript"
      />,
      { wrapper: LiveAnnouncerProvider },
    );
    // Both rows are in the document under keys of their own; a shared key would leave one,
    // because the library's caches are keyed by item key.
    expect(container.querySelectorAll(".meridian-transcript-viewport__row")).toHaveLength(2);
  });

  it("scrolls the scroll container through the binding its caller owns", () => {
    withLaidOutViewport();
    const holder: BindingHolder = { binding: undefined };
    const { container } = render(
      <ComposedTranscriptViewport
        clock={new ManualClock()}
        rows={syntheticRows(LONG_LOG_ROW_COUNT)}
        renderRow={renderRow}
        feedLabel="Transcript"
        holder={holder}
      />,
      { wrapper: LiveAnnouncerProvider },
    );
    const scrollContainer = container.querySelector<HTMLElement>(
      ".meridian-transcript-viewport__scroll-container",
    );
    expect(scrollContainer).not.toBeNull();
    expect(scrollContainer?.scrollTop).toBe(0);
    act(() => {
      holder.binding?.jumpToTail();
    });
    // The caller's binding reaches the element because the viewport takes it as a prop.
    expect(scrollContainer?.scrollTop).toBeGreaterThan(0);
  });
});

describe("the transcript viewport — what a row's lines say", () => {
  /** Every row draws its key, and the first row draws a refusal under it. */
  function renderRowWithRefusal(refusalWords: string): (row: ViewportRow) => React.ReactNode {
    return (row) =>
      row.key === "row-0" ? (
        <Nothing kind="error" placement="block" title={refusalWords} />
      ) : (
        <p>{row.key}</p>
      );
  }

  it("says nothing for a row's refusal as it mounts or remounts, and says a change once", () => {
    withLaidOutViewport();
    const holder: BindingHolder = { binding: undefined };
    const said = spiedAnnouncer();
    const viewportWith = (refusalWords: string): React.JSX.Element => (
      <LiveAnnouncerProvider announcer={said.announcer}>
        <ComposedTranscriptViewport
          clock={new ManualClock()}
          // Fewer than the window holds, so the first row stays in it while it is out of sight.
          rows={syntheticRows(HELD_LOG_ROW_COUNT)}
          renderRow={renderRowWithRefusal(refusalWords)}
          feedLabel="Transcript"
          holder={holder}
        />
      </LiveAnnouncerProvider>
    );
    const { rerender } = render(viewportWith("The daemon refused this turn."));
    // The transcript opens on its tail; the reader goes to the first row.
    act(() => {
      holder.binding?.jumpToRow("row-0");
    });
    expect(screen.getByText("The daemon refused this turn.")).toBeDefined();

    // Scrolled out of sight and back: the window unmounts the row and mounts it again.
    act(() => {
      holder.binding?.jumpToTail();
    });
    expect(screen.queryByText("The daemon refused this turn.")).toBeNull();
    act(() => {
      holder.binding?.jumpToRow("row-0");
    });
    expect(screen.getByText("The daemon refused this turn.")).toBeDefined();
    expect(said.spoken()).toStrictEqual([]);

    // The same row's words changing while it is in sight is news.
    rerender(viewportWith("The daemon refused this turn again."));
    expect(said.spoken()).toStrictEqual(["The daemon refused this turn again."]);
    expect(said.spokenOn("assertive")).toStrictEqual(["The daemon refused this turn again."]);
  });
});
