// The message card for user, agent and reasoning rows: open body, the author's hue on the edge. A
// reply's foot stands on its last row once the reply has drawn something to read, and stays for the
// rest of the turn: its time at rest, its Copy revealed on hover and focus. A user's actions are
// revealed on hover. A live `liveText` beats the stored body; a user body is the row's `summary`
// (`user.message` has no payload variant); reasoning is composed by the mount so a policy-withheld
// body stays distinguishable from an unreadable one.

import "./MessageRow.css";

import { useMemo } from "react";

import { CONTENT_LENGTH_PAYLOAD_KEY } from "@ai-sidekicks/contracts/event/declared-variants";

import { readWireString } from "#renderer/lib/wire/strings.js";
import { Glyph } from "#renderer/components/Glyph/Glyph.js";
import {
  TranscriptRowLayout,
  hueStepOf,
} from "../components/TranscriptRowLayout/TranscriptRowLayout.js";
import { type InlineCardProps } from "#renderer/registries/inline-cards/registry.js";
import { type RowKindDescriptor } from "./kind.js";
import type { HydratedRowProps } from "./hydrated-props.js";
import { InlineCards } from "./InlineCards.js";
import { CopyButton } from "#renderer/components/CopyButton/CopyButton.js";
import { useClipboardCopy } from "#renderer/services/platform/hooks/useClipboardCopy.js";
import { MessageContent } from "./bodies/MessageContent.js";
import { RecordedBodyLine } from "./RecordedBodyLine.js";
import { UserBody } from "./bodies/UserBody.js";
import { projectedPayload, readWireCount } from "#renderer/store/session/events/wire-payload.js";
import { replyClipboardContent } from "../copy/clipboard-flavors.js";
import { COPY_FLAVOR_ATTRIBUTE, type CopyFlavor } from "../copy/conversation-selection.js";
import { replyCopyFlavorOf } from "../copy/drawn-reply-text.js";
import { useReplyText } from "../copy/hooks/useReplyText.js";
import { publishedTextOf, type PublishedText } from "../reveal/published-text.js";

/** What a mount hands a message card, beyond the row itself. */
export interface MessageRowProps extends HydratedRowProps {
  /** The row's kind, as the dispatcher classified it: one of the three message kinds. */
  readonly rowKind: RowKindDescriptor;
  /** The inline cards this message carries, handed down rather than derived from the payload. */
  readonly inlineCards?: readonly InlineCardProps[] | undefined;
  /**
   * The edit affordance, or `undefined` when there is none. Required-with-undefined rather than
   * optional, so a mount that forgot it fails to compile instead of reading as a deliberate none.
   */
  readonly editControl: React.ReactNode | undefined;
  /**
   * The reasoning row's body, composed by the mount. Required-with-undefined on the same terms:
   * a missing one would fall back to the machine body and report a policy redaction as an
   * unreadable one.
   */
  readonly thinkingRow: React.ReactNode | undefined;
}

/** A user or agent message row: the sender's frame around its body, receipt and cards. */
export function MessageRow(props: MessageRowProps): React.JSX.Element {
  const rowKind = props.rowKind;
  const isUser = rowKind.kind === "user-message";
  const isReply = rowKind.kind === "agent-message";
  const payload = projectedPayload(props.row);
  // Read once for both readers below: the body's renderer and the receipt's own line.
  const assistantMediaType = readWireString(payload["contentType"]);
  // The text a Copy takes, as a handle: a stored string is read through one made once per string,
  // and the whole text is built only when Copy is pressed.
  const storedText = isUser
    ? props.row.summary === ""
      ? undefined
      : props.row.summary
    : rowKind.kind === "thinking" || props.liveText !== undefined
      ? undefined
      : props.content?.status === "available"
        ? props.content.body
        : undefined;
  const storedCopyText = useMemo(
    () => (storedText === undefined ? undefined : publishedTextOf(storedText)),
    [storedText],
  );
  const copyText: PublishedText | undefined =
    isUser || rowKind.kind === "thinking" ? storedCopyText : (props.liveText ?? storedCopyText);
  // A reply drawn as markdown copies as markdown with a formatted flavor beside it; the person's
  // own message, and a reply drawn as text, copy as plain text and nothing else.
  const copyFlavor: CopyFlavor =
    isReply && copyText !== undefined ? replyCopyFlavorOf(copyText, assistantMediaType) : "text";
  // A reply's time and Copy sit in its foot, on its last row, and Copy takes every row of the
  // reply, as markdown when any row is drawn as prose. The foot is drawn once the reply has drawn
  // text, so a time never stands over an empty answer, and both stay for the rest of the turn.
  // The time stands at rest and only the Copy waits for a hover or focus.
  const replyText = useReplyText(
    props.replyRowIds ?? NO_REPLY_ROWS,
    props.row.id,
    isReply && copyText !== undefined ? { text: copyText, flavor: copyFlavor } : undefined,
  );
  const clipboardCopy = useClipboardCopy(() => {
    if (!isReply) {
      return { text: copyText?.slice(0) ?? "" };
    }
    const wholeReply = replyText.read();
    return replyText.flavor === "markdown"
      ? replyClipboardContent(wholeReply)
      : { text: wholeReply };
  });
  const hasCopy = isReply ? replyText.hasText : copyText !== undefined;
  const copyButton = <CopyButton label="Copy" clipboardCopy={clipboardCopy} />;
  const copyControl = !hasCopy ? undefined : isReply ? (
    <span className="meridian-transcript-row-layout__revealed">{copyButton}</span>
  ) : (
    copyButton
  );
  const footer =
    isUser && props.editControl !== undefined ? (
      <>
        {copyControl}
        {props.editControl}
      </>
    ) : (
      copyControl
    );

  return (
    <TranscriptRowLayout
      agentHueStep={hueStepOf(props.agentHue)}
      occurredAtIso={props.row.timestamp}
      authorLabel={props.row.actor ?? rowKind.label}
      isSuperseded={props.isSuperseded}
      footer={footer}
      timePlacement={isReply ? (replyText.hasText ? "footer" : "none") : "gutter"}
      footerVisibility={isReply ? "always" : "on-hover"}
    >
      <div className={`meridian-message-card meridian-message-card--${rowKind.kind}`}>
        <span className="meridian-message-card__kind-label">
          {rowKind.glyph === undefined ? null : (
            <Glyph name={rowKind.glyph} title={rowKind.label} />
          )}
          {rowKind.label}
        </span>
        {/* The body alone is what a selection in the conversation copies out of this row. */}
        <div className="meridian-message-card__body" {...{ [COPY_FLAVOR_ATTRIBUTE]: copyFlavor }}>
          {isUser ? (
            <UserBody row={props.row} footnotes={props.footnotes} />
          ) : rowKind.kind === "thinking" ? (
            props.thinkingRow
          ) : (
            <MessageContent
              content={props.content}
              {...(props.liveText === undefined ? {} : { liveText: props.liveText })}
              // The media type is the producer-set `contentType` on the payload, and the same
              // reading feeds the receipt below, so the renderer and the printed type agree.
              {...(assistantMediaType === undefined ? {} : { contentType: assistantMediaType })}
              sourceId={props.row.id}
              footnotes={props.footnotes}
              label={rowKind.label}
              holdControlInPlace={props.holdControlInPlace}
            />
          )}
        </div>
        <InlineCards cards={props.inlineCards ?? []} />
        {isUser || rowKind.kind === "thinking" || props.liveText !== undefined ? null : (
          <RecordedBodyLine
            contentType={assistantMediaType}
            contentLength={readWireCount(payload, CONTENT_LENGTH_PAYLOAD_KEY)}
          />
        )}
      </div>
    </TranscriptRowLayout>
  );
}

/** The rows of no reply, for a message row that carries no reply's foot. */
const NO_REPLY_ROWS: readonly string[] = [];
