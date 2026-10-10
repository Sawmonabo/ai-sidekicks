// The one body a machine-authored row draws, in its four states: not read (a streamed row), large
// (its row carries its size alone, and its control reads it in full), unavailable, available. A
// truncated body renders its prefix and says so; an unreadable one keeps the turn at its position
// with the unavailable marker, because an empty body or a dropped row would misreport the turn.
// `MessageContent` and `ToolOutput` differ only in how a body's shape is read and in that a
// call's output is cut at a share of the visible flow. A live body is read through its lane's
// handle and a stored one through a handle over its string, so neither is copied whole on a frame.

import "./MachineBody.css";

import { useContext, useEffect, useMemo, useSyncExternalStore } from "react";

import type { TranscriptRowContent } from "@ai-sidekicks/contracts/transcript/content";

import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { byteFigurePart } from "#renderer/lib/figure-sentence.js";
import { publishedTextOf, type PublishedText } from "../../reveal/published-text.js";
import { AnsiOutput } from "../ansi/AnsiOutput.js";
import { withoutResidualEscapesOf } from "../ansi/escape-sequences.js";
import { FullBodyReadsContext, type FullBodyReads } from "../full-body-reads.js";
import { type FootnoteRegistry } from "../markdown/footnotes/registry.js";
import { FullOutputControl } from "./FullOutputControl.js";
import { OutputHeightCut } from "./OutputHeightCut.js";
import { type OutputKind } from "./output-kinds.js";
import { countPrintedLines } from "./printed-lines.js";
import { StreamingMarkdown } from "./StreamingMarkdown.js";
import { TruncationNotice } from "./TruncationNotice.js";
import { UnavailableBody } from "./UnavailableBody.js";

/** What a machine-authored body is drawn from, and how its shape is read. */
export interface MachineBodyProps {
  /** The body the row carries, or `undefined` when the row was streamed without one. */
  readonly content: TranscriptRowContent | undefined;
  /**
   * Text the reveal engine is publishing while the body streams, as the lane's handle. It takes
   * precedence over `content`, because a live body has no stored copy yet and nothing has been
   * truncated.
   */
  readonly liveText?: PublishedText | undefined;
  /** The renderer one body's bytes take. */
  readonly readOutputKind: (body: PublishedText) => OutputKind;
  /** The row this body belongs to: the footnote registry's first key half. */
  readonly sourceId: string;
  readonly footnotes: FootnoteRegistry;
  /** What a screen reader calls a command-output block. */
  readonly label: string;
  /**
   * Whether the body is a call's output, whose plain or command-output box is cut at a share of
   * the visible flow with the rest one press away; a reply's is drawn whole.
   */
  readonly isCutAtFlowHeight: boolean;
  /** Keep a pressed control where it stands while the body grows; see `TranscriptCardProps`. */
  readonly holdControlInPlace?: ((control: HTMLElement) => void) | undefined;
}

/** What a body not yet asked for says in its place, and a copy of it carries. */
export const UNREAD_BODY_TITLE = "This body has not been read.";

/** A machine-authored body: markdown, plain text or command output, as `readOutputKind` says. */
export function MachineBody(props: MachineBodyProps): React.JSX.Element {
  const storedBody =
    props.liveText === undefined && props.content?.status === "available"
      ? props.content.body
      : undefined;
  // One handle per stored string, so the segmenter sees the same text across renders.
  const storedText = useMemo(
    () => (storedBody === undefined ? undefined : publishedTextOf(storedBody)),
    [storedBody],
  );
  const bodyText = props.liveText ?? storedText;
  const kind = bodyText === undefined ? undefined : props.readOutputKind(bodyText);
  const revision = bodyText?.revision;
  const drawnText = useMemo(
    () =>
      bodyText === undefined || kind === "command-output"
        ? bodyText
        : withoutResidualEscapesOf(bodyText),
    // A live handle stays the same while it grows; its revision is what changed.
    [bodyText, revision, kind],
  );

  const fullBodyReads = useContext(FullBodyReadsContext);

  if (bodyText === undefined || kind === undefined || drawnText === undefined) {
    if (props.content?.status === "unavailable") {
      return <UnavailableBody />;
    }
    if (props.content?.status === "large" && fullBodyReads !== undefined) {
      return (
        <LargeBody
          rowId={props.sourceId}
          contentLength={props.content.contentLength}
          fullBodyReads={fullBodyReads}
          holdControlInPlace={props.holdControlInPlace}
        />
      );
    }
    // `not-checked`, not `not-loaded`: nothing was asked for, so a skeleton would promise a body.
    return <Nothing kind="not-checked" placement="inline" title={UNREAD_BODY_TITLE} />;
  }

  if (props.liveText !== undefined || props.content?.status !== "available") {
    return renderBodyText(props, kind, drawnText, false);
  }
  return (
    <div className="meridian-machine-body">
      {renderBodyText(props, kind, drawnText, true)}
      {props.content.contentTruncated === true ? (
        <TruncationNotice
          storedBody={props.content.body}
          preTruncationLength={props.content.contentLength}
        />
      ) : null}
    </div>
  );
}

/** What a large body's control reads and asks through. */
interface LargeBodyProps {
  readonly rowId: string;
  /** The whole body's UTF-8 byte length. */
  readonly contentLength: number;
  readonly fullBodyReads: FullBodyReads;
  readonly holdControlInPlace: ((control: HTMLElement) => void) | undefined;
}

/** A body its row carries as its size alone: the control that reads it in full. */
function LargeBody(props: LargeBodyProps): React.JSX.Element {
  const { fullBodyReads, rowId } = props;
  const reading = useSyncExternalStore(fullBodyReads.subscribe, () =>
    fullBodyReads.readingOf(rowId),
  );
  // Drawn again with its size alone, an opened body is read again, as the store let it go.
  useEffect(() => {
    fullBodyReads.readOpenedBody(rowId);
  }, [fullBodyReads, rowId]);
  return (
    <FullOutputControl
      measure={byteFigurePart("wire", props.contentLength)}
      reading={reading}
      onPress={(control) => {
        props.holdControlInPlace?.(control);
        fullBodyReads.open(rowId);
      }}
    />
  );
}

/**
 * The body's text through the renderer its kind names. Escapes were stripped for the markdown and
 * plain arms but not the ANSI one, where `anser` parses the styling out first.
 */
function renderBodyText(
  props: MachineBodyProps,
  kind: OutputKind,
  drawnText: PublishedText,
  isComplete: boolean,
): React.JSX.Element {
  if (kind === "command-output") {
    // Read through the handle: the block parses only the text past what it already parsed.
    return (
      <AnsiOutput
        publishedText={drawnText}
        label={props.label}
        isCutAtFlowHeight={props.isCutAtFlowHeight}
        holdControlInPlace={props.holdControlInPlace}
      />
    );
  }
  if (kind === "plain-text") {
    // Verbatim: no parse, no footnotes. Preformatted, so text copied out of it keeps its lines.
    // Drawn as the text's own chunks, one text node each, so the tree shares them.
    return (
      <OutputHeightCut
        className="meridian-machine-body__plain"
        isCutAtFlowHeight={props.isCutAtFlowHeight}
        readPrintedLineCount={() => countPrintedLines(drawnText.chunks())}
        holdControlInPlace={props.holdControlInPlace}
      >
        {drawnText.chunks()}
      </OutputHeightCut>
    );
  }
  return (
    <StreamingMarkdown
      publishedText={drawnText}
      sourceId={props.sourceId}
      footnotes={props.footnotes}
      isComplete={isComplete}
      // Only an agent's reply is drawn as prose here; a tool's output never is.
      offersBlockCopy
    />
  );
}
