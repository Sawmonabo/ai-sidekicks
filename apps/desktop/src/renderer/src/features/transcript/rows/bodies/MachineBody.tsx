// The one body a machine-authored row draws, in its four states: not read (a streamed row), large
// (its row carries its size alone, and its control reads it in full), unavailable, available. A
// truncated body renders its prefix and says so; an unreadable one keeps the turn at its position
// with the unavailable marker, because an empty body or a dropped row would misreport the turn.
// `MessageContent` and `ToolOutput` differ only in how a body's shape is read and in that a
// call's output is cut at a share of the visible flow until opened, a large one opened by the
// press that reads it, so it draws whole once read. A live body is read through its lane's
// handle and a stored one through a handle over its string, so neither is copied whole on a frame.
// What the body draws, the row's preparation readied: an output's lines and a reply's markdown,
// stripped of escapes there, so a body is drawn only inside the feed that prepares it.

import "./MachineBody.css";

import { useContext, useEffect, useMemo, useSyncExternalStore } from "react";

import type { TranscriptRowContent } from "@ai-sidekicks/contracts/transcript/content";

import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { byteFigurePart } from "#renderer/lib/figure-sentence.js";
import { LARGE_BODY_ATTRIBUTE } from "../../copy/conversation-selection.js";
import { publishedTextOf, type PublishedText } from "../../reveal/published-text.js";
import { AnsiOutput } from "../ansi/AnsiOutput.js";
import { FullBodyReadsContext, type FullBodyReads } from "../full-body-reads.js";
import { type FootnoteRegistry } from "../markdown/footnotes/registry.js";
import { FullOutputControl } from "./FullOutputControl.js";
import { PreparedMarkdown } from "./PreparedMarkdown.js";
import { type OutputOpening } from "./OutputHeightCut.js";
import { type OutputKind } from "./output-kinds.js";
import { TruncationNotice } from "./TruncationNotice.js";
import { UnavailableBody } from "./UnavailableBody.js";
import { useLiveOutputByteLength } from "./hooks/useLiveOutputByteLength.js";

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
   * A call's output's opening: its plain or command-output box is cut at a share of the visible
   * flow until opened, the rest one press away. Absent, as on a reply, the body is drawn whole.
   */
  readonly opening?: OutputOpening | undefined;
  /** Hold the row where it stands while the body grows; see `TranscriptCardProps`. */
  readonly holdRowInPlace?: (() => void) | undefined;
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

  const fullBodyReads = useContext(FullBodyReadsContext);
  // Only a call's output names its running size; a streaming reply is never cut.
  const liveByteLength = useLiveOutputByteLength(
    props.opening === undefined ? undefined : props.liveText,
  );

  if (kind === undefined) {
    if (props.content?.status === "unavailable") {
      return <UnavailableBody />;
    }
    if (props.content?.status === "large" && fullBodyReads !== undefined) {
      return (
        <LargeBody
          rowId={props.sourceId}
          contentLength={props.content.contentLength}
          fullBodyReads={fullBodyReads}
          opening={props.opening}
          holdRowInPlace={props.holdRowInPlace}
        />
      );
    }
    // `not-checked`, not `not-loaded`: nothing was asked for, so a skeleton would promise a body.
    return <Nothing kind="not-checked" placement="inline" title={UNREAD_BODY_TITLE} />;
  }

  if (props.liveText !== undefined || props.content?.status !== "available") {
    return renderBodyText(props, kind, liveByteLength);
  }
  return (
    <div className="meridian-machine-body">
      {renderBodyText(props, kind, undefined)}
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
  /** A call's output's opening, which the press opens too, so the body draws whole once read. */
  readonly opening: OutputOpening | undefined;
  readonly holdRowInPlace: (() => void) | undefined;
}

/**
 * A body its row carries as its size alone: the control that reads it in full, in the place a
 * selection copies as the body read in full.
 */
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
    <div {...{ [LARGE_BODY_ATTRIBUTE]: "" }}>
      <FullOutputControl
        measure={byteFigurePart("wire", props.contentLength)}
        reading={reading}
        onPress={() => {
          // Opening the output holds the row in place itself.
          if (props.opening === undefined) {
            props.holdRowInPlace?.();
          } else {
            props.opening.open();
          }
          fullBodyReads.open(rowId);
        }}
      />
    </div>
  );
}

/**
 * The body's text through the renderer its kind names, a running command's output with the bytes
 * arrived so far, each as the row's preparation readied it.
 */
function renderBodyText(
  props: MachineBodyProps,
  kind: OutputKind,
  liveByteLength: number | undefined,
): React.JSX.Element {
  if (kind === "prose") {
    // Only an agent's reply is drawn as prose here; a tool's output never is.
    return (
      <PreparedMarkdown sourceId={props.sourceId} footnotes={props.footnotes} offersBlockCopy />
    );
  }
  // The row's preparation parsed the text into lines, past what it already parsed. Plain text is
  // drawn verbatim, its lines unstyled: no markdown, no footnotes, preformatted, so text copied out
  // of it keeps its lines.
  const isCommandOutput = kind === "command-output";
  return (
    <AnsiOutput
      className={isCommandOutput ? "meridian-ansi__body" : "meridian-machine-body__plain"}
      label={isCommandOutput ? props.label : undefined}
      rowKey={props.sourceId}
      opening={props.opening}
      liveByteLength={liveByteLength}
    />
  );
}
