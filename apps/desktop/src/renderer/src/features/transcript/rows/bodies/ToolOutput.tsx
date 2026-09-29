// What a tool or command returned, its error included, in the same three states as the
// reply: not asked for, asked and unavailable, asked and available.
//
// A tool result declares no media type (the tool payload carries a name, a call id, a
// duration and the body's descriptors), so its bytes decide the renderer: a body carrying
// an escape is command output, any other is prose. A shape is never derived from the
// tool's name.

import type { HydratedSessionEventContent } from "@ai-sidekicks/contracts";

import { Nothing } from "@renderer/console/primitives/index.js";
import { AnsiOutput } from "../ansi/AnsiOutput.js";
import { withoutResidualEscapes } from "../ansi/escape-sequences.js";
import { type FootnoteRegistry } from "../markdown/footnotes/footnote-registry.js";
import { outputKindOf } from "./output-kinds.js";
import { StreamingMarkdown } from "./StreamingMarkdown.js";
import { TruncationNotice } from "./TruncationNotice.js";
import { UnavailableBody } from "./UnavailableBody.js";

/** What the tool's result is drawn from. */
export interface ToolOutputProps {
  /**
   * The hydrated body as the read projection reports it, or `undefined` when it has not
   * been asked for.
   */
  readonly content: HydratedSessionEventContent | undefined;
  /** Text the reveal engine is publishing while the result streams; wins over `content`. */
  readonly liveText?: string | undefined;
  /** The row this body belongs to: the footnote registry's first key half. */
  readonly sourceId: string;
  readonly footnotes: FootnoteRegistry;
  /** What a screen reader calls a command-output block. */
  readonly label: string;
}

/** A tool's result: command output when its bytes carry an escape, otherwise markdown. */
export function ToolOutput(props: ToolOutputProps): React.JSX.Element {
  if (props.liveText !== undefined) {
    return renderBodyText(props, props.liveText, false);
  }

  if (props.content === undefined) {
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

/** The result's bytes through the ANSI renderer or, with residue stripped, markdown. */
function renderBodyText(
  props: ToolOutputProps,
  body: string,
  isComplete: boolean,
): React.JSX.Element {
  if (outputKindOf(body) === "command-output") {
    return <AnsiOutput source={body} label={props.label} />;
  }
  return (
    <StreamingMarkdown
      publishedText={withoutResidualEscapes(body)}
      sourceId={props.sourceId}
      footnotes={props.footnotes}
      isComplete={isComplete}
    />
  );
}
