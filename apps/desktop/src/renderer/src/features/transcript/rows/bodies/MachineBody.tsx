// The one body a machine-authored row draws, in its three states: not asked for, unavailable,
// available. A truncated body renders its prefix and says so; an unreadable one keeps the turn at
// its position with the unavailable marker, because an empty body or a dropped row would misreport
// the turn. `MessageContent` and `ToolOutput` differ only in how a body's shape is read. A live
// body is read through its lane's handle and a stored one through a handle over its string, so
// neither is copied whole on a frame.

import "./MachineBody.css";

import { useMemo } from "react";

import type { HydratedSessionEventContent } from "@ai-sidekicks/contracts/event/envelope";

import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { publishedTextOf, type PublishedText } from "../../reveal/published-text.js";
import { AnsiOutput } from "../ansi/AnsiOutput.js";
import { carriesAnsiEscapes, withoutResidualEscapes } from "../ansi/escape-sequences.js";
import { type FootnoteRegistry } from "../markdown/footnotes/registry.js";
import { type OutputKind } from "./output-kinds.js";
import { StreamingMarkdown } from "./StreamingMarkdown.js";
import { TruncationNotice } from "./TruncationNotice.js";
import { UnavailableBody } from "./UnavailableBody.js";

/** What a machine-authored body is drawn from, and how its shape is read. */
export interface MachineBodyProps {
  /**
   * The hydrated body as the read projection reports it, or `undefined` when it has not
   * been asked for.
   */
  readonly content: HydratedSessionEventContent | undefined;
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
  /** Keep a pressed control where it stands while the body grows; see `HydratedRowProps`. */
  readonly holdControlInPlace?: ((control: HTMLElement) => void) | undefined;
}

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

  if (bodyText === undefined || kind === undefined || drawnText === undefined) {
    if (props.content?.status === "unavailable") {
      return <UnavailableBody />;
    }
    // `not-checked`, not `not-loaded`: nothing was asked for, so a skeleton would promise a body.
    return <Nothing kind="not-checked" placement="inline" title="This body has not been read." />;
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
        holdControlInPlace={props.holdControlInPlace}
      />
    );
  }
  if (kind === "plain-text") {
    // Verbatim: no parse, no footnotes. Preformatted, so text copied out of it keeps its lines.
    // Drawn as the text's own chunks, one text node each, so the tree shares them.
    return <pre className="meridian-machine-body__plain">{drawnText.chunks()}</pre>;
  }
  return (
    <StreamingMarkdown
      publishedText={drawnText}
      sourceId={props.sourceId}
      footnotes={props.footnotes}
      isComplete={isComplete}
      // Only an agent's reply is drawn as prose here; a tool's output never is.
      offersCodeCopy
    />
  );
}

/**
 * The text without escape sequences: the same handle for a text that carries none, the usual
 * case. One that carries some is stripped whole, into a string of its own.
 */
function withoutResidualEscapesOf(text: PublishedText): PublishedText {
  return carriesAnsiEscapes(text) ? publishedTextOf(withoutResidualEscapes(text.slice(0))) : text;
}
