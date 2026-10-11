// Command output: the spans `spans.ts` parses from the output's text, grouped in chunks of whole
// lines, in one output box, which a call's output takes cut at the visible flow until its opening
// is pressed. Each chunk is a block of its lines in flow, so every line wraps and stands as it
// would in one block. Inside a transcript viewport a long output draws as a window over its chunks,
// only those near the reader mounted and a spacer holding the room of each run of the rest, its
// chunks measured off screen a slice at a time so the spacers hold their real room. The box parses
// nothing: it draws the chunks the row's preparation published, which parses a streaming output
// only past what earlier revisions parsed, so a revision redraws only the last chunk.

import { memo, useContext, useSyncExternalStore } from "react";

import { MeasuringFrames } from "../bodies/MeasuringFrames.js";
import { OutputHeightCut, type OutputOpening } from "../bodies/OutputHeightCut.js";
import {
  MarkdownWindowViewportContext,
  type MarkdownWindowViewport,
} from "../markdown/block-window/context.js";
import { useAnsiLineWindow } from "./hooks/useAnsiLineWindow.js";
import { type AnsiLineChunk, type AnsiLineChunkList } from "./lines/chunks.js";
import {
  ANSI_FIRST_UNDRAWN_CHUNK_ATTRIBUTE,
  ANSI_LAST_UNDRAWN_CHUNK_ATTRIBUTE,
  ANSI_LINE_CHUNK_INDEX_ATTRIBUTE,
  ANSI_OUTPUT_KEY_ATTRIBUTE,
} from "./lines/markers.js";
import { type AnsiChunkMeasurement } from "./lines/measurement.js";
import { PreparedAnsiOutputsContext } from "./preparation.js";
import { ansiSpanClassNames } from "./spans.js";

import "./AnsiOutput.css";

/** Which row's output to render and the label a screen reader gives its block. */
export interface AnsiOutputProps {
  /** What a screen reader calls this block. */
  readonly label: string;
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
 * Renders a row's ANSI-styled command output in one output box, as the feed's preparation of the
 * row parsed it; empty while none is published. Throws outside a feed, where nothing parses it.
 */
export function AnsiOutput(props: AnsiOutputProps): React.JSX.Element {
  const preparedOutputs = useContext(PreparedAnsiOutputsContext);
  if (preparedOutputs === undefined) {
    throw new Error("A command output is drawn only inside a transcript feed, which parses it.");
  }
  const rowKey = props.rowKey;
  const chunks = useSyncExternalStore(preparedOutputs.subscribe, () =>
    preparedOutputs.chunksOf(rowKey),
  );
  const viewport = useContext(MarkdownWindowViewportContext);

  return (
    <OutputHeightCut
      className="meridian-ansi__body"
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
  readonly viewport: MarkdownWindowViewport;
  /** The row the output belongs to; held for the window's life. */
  readonly rowKey: string;
}

/** A long output's lines, drawn chunk by chunk where the reader can see them. */
function WindowedAnsiLines(props: WindowedAnsiLinesProps): React.JSX.Element {
  const { chunks } = props;
  const lineWindow = useAnsiLineWindow(chunks, props.viewport, props.rowKey);
  return (
    <>
      <span className="meridian-ansi__lines" ref={lineWindow.attachLines}>
        {lineWindow.rows.map((row) =>
          row.kind === "spacer" ? (
            <span
              key={row.key}
              className="meridian-ansi__chunk"
              aria-hidden="true"
              style={{ height: `${String(row.heightPx)}px` }}
              {...{
                [ANSI_OUTPUT_KEY_ATTRIBUTE]: lineWindow.outputKey,
                [ANSI_FIRST_UNDRAWN_CHUNK_ATTRIBUTE]: row.firstIndex,
                [ANSI_LAST_UNDRAWN_CHUNK_ATTRIBUTE]: row.lastIndex,
              }}
            />
          ) : (
            <AnsiChunk
              key={row.key}
              chunk={chunks.chunkAt(row.index)}
              index={row.index}
              attach={lineWindow.attachChunk}
            />
          ),
        )}
      </span>
      <AnsiMeasuringFrame measurement={lineWindow.measurement} />
    </>
  );
}

/**
 * The chunks a long output measures off screen, drawn hidden in the window's measuring frames at
 * the lines' width, inside an output box of their own, whose class sets the lines' type.
 */
function AnsiMeasuringFrame(props: {
  readonly measurement: AnsiChunkMeasurement;
}): React.JSX.Element | null {
  const { measurement } = props;
  const frame = useSyncExternalStore(measurement.subscribe, measurement.read);
  if (frame === undefined) {
    return null;
  }
  return (
    <MeasuringFrames ownerDocument={frame.ownerDocument}>
      <pre className="meridian-ansi__body">
        <span className="meridian-ansi__lines" style={{ width: `${String(frame.widthPx)}px` }}>
          {frame.chunks.map(({ index, chunk }) => (
            <AnsiChunk
              key={`${String(frame.slice)}:${String(index)}`}
              chunk={chunk}
              index={index}
              attach={measurement.attachChunk}
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
