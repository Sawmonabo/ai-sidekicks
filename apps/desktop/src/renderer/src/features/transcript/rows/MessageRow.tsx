// The message card for user, agent and reasoning rows: open body, the author's hue on the edge,
// hover-revealed affordances. A live `liveText` beats the stored body; a user body is the row's
// `summary` (`user.message` has no payload variant); reasoning is composed by the mount so a
// policy-withheld body stays distinguishable from an unreadable one.

import { readWireString } from "@renderer/lib/wire-strings.js";
import { Glyph } from "@renderer/components/Glyph/Glyph.js";
import { TranscriptRowLayout } from "../components/TranscriptRowLayout/TranscriptRowLayout.js";
import { type InlineCardProps } from "@renderer/registries/inline-cards/inline-card-registry.js";
import { TranscriptRowGroup } from "../viewport/components/TranscriptRowGroup.js";
import { type RowKindDescriptor } from "./row-kind.js";
import type { HydratedRowProps } from "./hydrated-row-props.js";
import { InlineCards } from "./InlineCards.js";
import { CopyButton } from "./components/CopyButton.js";
import { MessageContent } from "./bodies/MessageContent.js";
import { RecordedBodyLine } from "./RecordedBodyLine.js";
import { UserBody } from "./bodies/UserBody.js";
import { projectedPayload, readWireCount } from "@renderer/store/session-events/wire-payload.js";

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
  const payload = projectedPayload(props.row);
  // Read once for both readers below: the body's renderer and the receipt's own line.
  const assistantMediaType = readWireString(payload["contentType"]);
  const copyText = isUser
    ? props.row.summary === ""
      ? undefined
      : props.row.summary
    : rowKind.kind === "thinking"
      ? undefined
      : (props.liveText ??
        (props.content?.status === "available" ? props.content.body : undefined));
  const copyControl = copyText === undefined ? undefined : <CopyButton text={copyText} />;
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
    <TranscriptRowGroup groupLabel="a message row">
      <TranscriptRowLayout
        agentHueStep={props.agentHue?.step ?? -1}
        occurredAtIso={props.row.timestamp}
        authorLabel={props.row.actor ?? rowKind.label}
        kindLabel={props.row.type}
        isSuperseded={props.isSuperseded}
        footer={footer}
      >
        <div className={`meridian-message-card meridian-message-card--${rowKind.kind}`}>
          <span className="meridian-message-card__kind-label">
            {rowKind.glyph === undefined ? null : (
              <Glyph name={rowKind.glyph} title={rowKind.label} />
            )}
            {rowKind.label}
          </span>
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
            />
          )}
          <InlineCards cards={props.inlineCards ?? []} />
          {isUser || rowKind.kind === "thinking" || props.liveText !== undefined ? null : (
            <RecordedBodyLine
              contentType={assistantMediaType}
              contentLength={readWireCount(payload, "contentLength")}
            />
          )}
        </div>
      </TranscriptRowLayout>
    </TranscriptRowGroup>
  );
}
