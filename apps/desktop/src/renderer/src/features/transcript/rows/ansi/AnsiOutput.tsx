// A row's output, a command's or plain text: the spans `spans.ts` parses from the output's text,
// styled or, for plain text, not, grouped in chunks of whole lines, in one output box, which a
// call's output takes cut at the visible flow until its opening is pressed. Each chunk is a block
// of its lines in flow, so every line wraps and stands as it would in one block. Inside a
// transcript viewport a long output draws as a window over its chunks, only those near the reader
// mounted and a spacer holding the room of each run of the rest, its chunks measured off screen a
// slice at a time so the spacers hold their real room. The box parses nothing: it draws the chunks
// the row's preparation published, which parses a streaming output only past what earlier revisions
// parsed, so a revision redraws only the last chunk.

import { memo, useContext, useSyncExternalStore } from "react";

import { MeasuringFrames } from "#renderer/components/MeasuringFrames/MeasuringFrames.js";
import {
  FIRST_UNDRAWN_ITEM_ATTRIBUTE,
  LAST_UNDRAWN_ITEM_ATTRIBUTE,
  UNDRAWN_TEXT_SOURCE_ATTRIBUTE,
} from "#renderer/components/TranscriptBodyViewport/drawn-window-sources.js";
import { OutputHeightCut, type OutputOpening } from "../bodies/OutputHeightCut.js";
import {
  TranscriptBodyViewportContext,
  type TranscriptBodyViewport,
} from "#renderer/components/TranscriptBodyViewport/context.js";
import { useAnsiLineWindow } from "./hooks/useAnsiLineWindow.js";
import { type AnsiLineChunk, type AnsiLineChunkList } from "./lines/chunks.js";
import { ANSI_LINE_CHUNK_INDEX_ATTRIBUTE } from "./lines/markers.js";
import { PreparedBodiesContext } from "../prepared-bodies.js";
import { type OffScreenMeasurement } from "#renderer/lib/off-screen-measurement.js";
import { ansiSpanClassNames } from "./spans.js";

import "./AnsiOutput.css";

/** Which row's output to render, in which box, and the label a screen reader gives its block. */
export interface AnsiOutputProps {
  /** The box's own class, which sets the lines' type and the box around them. */
  readonly className: string;
  /** What a screen reader calls this block, where it names one. */
  readonly label?: string | undefined;
  /**
   * The row the output belongs to: its chunks are the ones the feed's preparation of the row
   * published, and a windowed output is laid out from the row's top.
   */
  readonly rowKey: string;
  /** A call's output's opening, cut at the visible flow until opened; absent, drawn whole. */
  readonly opening?: OutputOpening | undefined;
  /** The bytes a running command's output holds so far; absent once it settled. */
  readonly liveByteLength?: number | undefined;
}

/**
 * Renders a row's output in one output box, as the feed's preparation of the row parsed it; empty
 * while none is published. Throws outside a feed, where nothing parses it.
 */
export function AnsiOutput(props: AnsiOutputProps): React.JSX.Element {
  const preparedBodies = useContext(PreparedBodiesContext);
  if (preparedBodies === undefined) {
    throw new Error("An output is drawn only inside a transcript feed, which parses it.");
  }
  const rowKey = props.rowKey;
  const chunks = useSyncExternalStore(preparedBodies.subscribe, () =>
    preparedBodies.chunksOf(rowKey),
  );
  const viewport = useContext(TranscriptBodyViewportContext);

  return (
    <OutputHeightCut
      className={props.className}
      rowKey={rowKey}
      label={props.label}
      opening={props.opening}
      liveByteLength={props.liveByteLength}
    >
      {chunks !== undefined &&
      viewport !== undefined &&
      chunks.count >= WINDOWED_OUTPUT_MIN_CHUNKS ? (
        <WindowedAnsiLines
          // A rewrite parsed from the start remounts the window with its measurements.
          key={chunks.generation}
          chunks={chunks}
          viewport={viewport}
          rowKey={props.rowKey}
          className={props.className}
        />
      ) : (
        <span className="meridian-ansi__lines">
          {chunks === undefined
            ? null
            : Array.from({ length: chunks.count }, (_unused, index) => (
                <AnsiChunk
                  key={`${String(chunks.generation)}:${String(index)}`}
                  chunk={chunks.chunkAt(index)}
                  index={index}
                  attach={undefined}
                />
              ))}
        </span>
      )}
    </OutputHeightCut>
  );
}

/**
 * How many chunks an output in a viewport holds before it draws as a window: a shorter one draws
 * whole, where the window would spare too little to be worth following the scroller.
 */
const WINDOWED_OUTPUT_MIN_CHUNKS = 3;

/** What a windowed output's lines are drawn from. */
interface WindowedAnsiLinesProps {
  readonly chunks: AnsiLineChunkList;
  /** The viewport the output is drawn in; held for the window's life. */
  readonly viewport: TranscriptBodyViewport;
  /** The row the output belongs to; held for the window's life. */
  readonly rowKey: string;
  /** The output box's class, which the measuring frame's box takes too. */
  readonly className: string;
}

/** A long output's lines, drawn chunk by chunk where the reader can see them. */
function WindowedAnsiLines(props: WindowedAnsiLinesProps): React.JSX.Element {
  const { chunks } = props;
  const lineWindow = useAnsiLineWindow(chunks, props.viewport, props.rowKey);
  return (
    <>
      <span className="meridian-ansi__lines" ref={lineWindow.layout.attachLines}>
        {lineWindow.rows.map((row) =>
          row.kind === "spacer" ? (
            <span
              key={row.key}
              className="meridian-ansi__chunk"
              aria-hidden="true"
              style={{ height: `${String(row.heightPx)}px` }}
              {...{
                [UNDRAWN_TEXT_SOURCE_ATTRIBUTE]: lineWindow.sourceKey,
                [FIRST_UNDRAWN_ITEM_ATTRIBUTE]: row.firstIndex,
                [LAST_UNDRAWN_ITEM_ATTRIBUTE]: row.lastIndex,
              }}
            />
          ) : (
            <AnsiChunk
              key={row.key}
              chunk={chunks.chunkAt(row.index)}
              index={row.index}
              attach={lineWindow.attachItem}
            />
          ),
        )}
      </span>
      <AnsiMeasuringFrame
        measurement={lineWindow.layout.window.measurement}
        className={props.className}
      />
    </>
  );
}

/**
 * The chunks a long output measures off screen, drawn hidden in the window's measuring frames at
 * the lines' width, inside an output box of their own: the output box's class, and the type the
 * lines inherit in their row set on it, as the frames stand outside the row.
 */
function AnsiMeasuringFrame(props: {
  readonly measurement: OffScreenMeasurement<AnsiLineChunk>;
  readonly className: string;
}): React.JSX.Element | null {
  const { measurement } = props;
  const frame = useSyncExternalStore(measurement.subscribe, measurement.read);
  if (frame === undefined) {
    return null;
  }
  return (
    <MeasuringFrames ownerDocument={frame.box.ownerDocument}>
      <pre
        className={props.className}
        ref={(box) => {
          if (box !== null) {
            box.style.cssText = frame.box.textStyle;
          }
        }}
      >
        <span className="meridian-ansi__lines" style={{ width: `${String(frame.box.widthPx)}px` }}>
          {frame.items.map(({ index, item: chunk }) => (
            <AnsiChunk
              key={`${String(frame.slice)}:${String(index)}`}
              chunk={chunk}
              index={index}
              attach={measurement.attachItem}
            />
          ))}
        </span>
      </pre>
    </MeasuringFrames>
  );
}

/** One chunk to draw, its index, and what measures it in a window. */
interface AnsiChunkProps {
  readonly chunk: AnsiLineChunk;
  readonly index: number;
  readonly attach: ((element: HTMLElement | null) => void) | undefined;
}

/** One chunk of an output's lines, its spans in a block; a closed chunk draws once. */
const AnsiChunk = memo(function AnsiChunk(props: AnsiChunkProps): React.JSX.Element {
  return (
    <span
      className="meridian-ansi__chunk"
      ref={props.attach}
      {...{ [ANSI_LINE_CHUNK_INDEX_ATTRIBUTE]: props.index }}
    >
      {props.chunk.spans.map((span, index) => {
        const classNames = ansiSpanClassNames(span);
        // The index is in the key because identical adjacent runs are distinct; the text is in
        // it so a re-parse that shifts a boundary does not reuse a node whose content changed.
        return (
          <span key={`${String(index)}:${span.text}`} className={classNames.join(" ")}>
            {span.text}
          </span>
        );
      })}
    </span>
  );
});
