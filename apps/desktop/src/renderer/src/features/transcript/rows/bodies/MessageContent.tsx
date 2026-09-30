// The agent's reply in its three states: not asked for, unavailable, available. A truncated body
// renders its prefix and says so; an unreadable one keeps the turn at its position with the
// unavailable marker, because an empty body or a dropped row would misreport the turn.

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
    // `not-checked`, not `not-loaded`: nothing was asked for, so a skeleton would promise a body.
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
 * The body's bytes through the renderer its kind names. Escapes are stripped for the markdown
 * and plain arms but not the ANSI one, where `anser` parses the styling out first.
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
    // Verbatim: no parse, no footnotes.
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
