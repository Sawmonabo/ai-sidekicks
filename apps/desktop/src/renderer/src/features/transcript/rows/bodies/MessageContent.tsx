// The agent's reply, drawn honestly in each of its three states: not asked for, asked and
// unavailable, asked and available.
//
// A truncated body renders its prefix and says so (`TruncationNotice`); an unreadable one
// keeps the turn at its position with the unavailable marker (`UnavailableBody`). Neither
// is silent: an empty body reads as "the author said nothing" and a dropped row as "the
// turn never happened", and both are false. `ToolOutput` draws a tool's result the same
// way through the same two notices.

import type { HydratedSessionEventContent } from "@ai-sidekicks/contracts";

import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { AnsiOutput } from "../ansi/AnsiOutput.js";
import { withoutResidualEscapes } from "../ansi/escape-sequences.js";
import { type FootnoteRegistry } from "../markdown/footnotes/footnote-registry.js";
import { outputKindOf } from "./output-kinds.js";
import { StreamingMarkdown } from "./StreamingMarkdown.js";
import { TruncationNotice } from "./TruncationNotice.js";
import { UnavailableBody } from "./UnavailableBody.js";

/** What the reply's body is drawn from. */
export interface MessageContentProps {
  /**
   * The hydrated body as the read projection reports it, or `undefined` when it has not
   * been asked for.
   */
  readonly content: HydratedSessionEventContent | undefined;
  /**
   * Text the reveal engine is publishing while the turn streams. It takes precedence over
   * `content`, because a live turn has no stored body yet and nothing has been truncated.
   */
  readonly liveText?: string | undefined;
  /**
   * The media type the producer declared (`AssistantOutputPayload.contentType`), a
   * free-form wire string.
   */
  readonly contentType?: string | undefined;
  /** The row this body belongs to: the footnote registry's first key half. */
  readonly sourceId: string;
  readonly footnotes: FootnoteRegistry;
  /** What a screen reader calls a command-output block. */
  readonly label: string;
}

/** The agent's reply: markdown, plain text or command output, by its declared type. */
export function MessageContent(props: MessageContentProps): React.JSX.Element {
  if (props.liveText !== undefined) {
    return renderBodyText(props, props.liveText, false);
  }

  if (props.content === undefined) {
    // `not-checked`, not `not-loaded`: nothing was asked for, so nothing is arriving and a
    // skeleton would promise a body a beat later.
    return <Nothing kind="not-checked" placement="inline" title="This body has not been read." />;
  }

  if (props.content.status === "unavailable") {
    return <UnavailableBody reason={props.content.reason} />;
  }

  const body = props.content.body;
  return (
    <div className="meridian-machine-body">
      {renderBodyText(props, body, true)}
      {props.content.contentTruncated === true ? (
        <TruncationNotice storedBody={body} preTruncationLength={props.content.contentLength} />
      ) : null}
    </div>
  );
}

/**
 * The body's bytes through the renderer its kind names.
 *
 * Escapes are stripped for the markdown and plain arms and never for the ANSI one: the
 * terminal pipeline removes residue after `anser` has parsed the styling out of it, and a
 * pre-pass would take the styling with it.
 */
function renderBodyText(
  props: MessageContentProps,
  body: string,
  isComplete: boolean,
): React.JSX.Element {
  const kind = outputKindOf(body, props.contentType);
  if (kind === "command-output") {
    return <AnsiOutput source={body} label={props.label} />;
  }
  const declaredText = withoutResidualEscapes(body);
  if (kind === "plain-text") {
    // No parse and no footnotes: the sheet keeps the line breaks and runs of spaces.
    return <p className="meridian-machine-body__plain">{declaredText}</p>;
  }
  return (
    <StreamingMarkdown
      publishedText={declaredText}
      sourceId={props.sourceId}
      footnotes={props.footnotes}
      isComplete={isComplete}
    />
  );
}
