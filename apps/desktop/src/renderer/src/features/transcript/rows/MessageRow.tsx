// The message card — a user's words, an agent's reply, and an agent's reasoning.
//
// Three of `row-kind.ts`'s five families live here and share one layout: the body is
// open, the attribution edge carries the author's hue, and the row's affordances are
// revealed on hover rather than parked in the log, because secondary controls live one
// click away.
//
// WHERE EACH BODY COMES FROM, which is the one thing about this card that is not
// obvious:
//
//   • An ASSISTANT body is machine-authored, so it arrives through the hydrated
//     `content` projection and renders through `MessageContent`, including its truncation
//     and unavailability dispositions, which are `MessageContent`'s and not this card's.
//   • A LIVE assistant body arrives as `liveText`, published by the reveal engine and
//     handed down by the viewport. It takes precedence, because a turn still streaming
//     has no stored body yet.
//   • A USER body arrives as the row's own `summary`, and that is the whole of
//     what the wire carries. `user.message` is a registered event type with NO payload
//     variant: a user's words are sealed in the per-user encrypted column
//     and the hydrated content projection covers the machine-authored one. There is no
//     timeline carrier for user text, so the card renders what exists rather than
//     reaching for what does not — and never captions the summary as if it were the
//     message.
//
// AND A REASONING BODY IS NOT A MACHINE BODY. The reasoning family renders the
// four-arm availability surface rather than the hydrated content projection: those
// are two different reads answering two different questions, and rendering reasoning
// through `MessageContent` made a turn whose reasoning was WITHHELD by policy
// indistinguishable from one whose stored body could not be opened. The element is
// composed by the mount and handed down, for the reason the edit affordance is —
// this card decides layout, and what a row is allowed to show is decided by the
// surface that performed the read.
//
// THE EDIT AFFORDANCE IS NOT A CONTROL THIS FILE WRITES. The pencil that opens an inline
// editor belongs to the run controls, and this card never re-authors a body they own. It
// mounts whatever element it is handed in the row's hover footer.

import { readWireString } from "@renderer/lib/wire-strings.js";
import { Glyph, LedgerRow } from "@renderer/console/primitives/index.js";
import { type InlineCardSeatProps } from "@renderer/console/seats/index.js";
import { TranscriptRowGroup } from "../viewport/components/TranscriptRowGroup.js";
import { type RowKindDescriptor } from "./row-kind.js";
import type { HydratedRowProps } from "./hydrated-row-props.js";
import { InlineCards } from "./InlineCards.js";
import { MessageContent } from "./bodies/MessageContent.js";
import { RecordedBodyLine } from "./RecordedBodyLine.js";
import { UserBody } from "./bodies/UserBody.js";
import { projectedPayload, readWireCount } from "@renderer/store/session-events/wire-payload.js";

/** What a mount hands a message card, beyond the row itself. */
export interface MessageRowProps extends HydratedRowProps {
  /** The row's kind, as the dispatcher classified it: one of the three message kinds. */
  readonly rowKind: RowKindDescriptor;
  /**
   * The inline cards this message carries.
   *
   * Handed down rather than derived from the row: a message's attachments are not a
   * member of any registered payload — `SteerPayload.attachments` is `unknown[]` by
   * contract — so a card that built these from the wire would be inventing the wire.
   */
  readonly inlineCards?: readonly InlineCardSeatProps[] | undefined;
  /**
   * The edit affordance, or `undefined` while none is supplied.
   *
   * Required and carrying `undefined` rather than optional, so a mount that forgot it is a
   * compile error at the construction site instead of an absent key that renders
   * identically to a deliberate "none".
   */
  readonly editControl: React.ReactNode | undefined;
  /**
   * The reasoning row's body, composed by the mount.
   *
   * Required and carrying `undefined` rather than optional, on the same terms as the edit
   * affordance above: a mount that composed no reasoning surface for a reasoning row is a
   * compile error at the construction site rather than a row that silently falls back
   * to the machine body and reports a policy redaction as an unreadable one.
   */
  readonly thinkingRow: React.ReactNode | undefined;
}

/** A user or agent message row: the sender's frame around its body, receipt and cards. */
export function MessageRow(props: MessageRowProps): React.JSX.Element {
  const family = props.rowKind;
  const isUser = family.kind === "user-message";
  const payload = projectedPayload(props.row);
  // Read once for both readers below: the body's renderer and the receipt's own line.
  const assistantMediaType = readWireString(payload["contentType"]);

  return (
    <TranscriptRowGroup groupLabel="a message row">
      <LedgerRow
        agentHueStep={props.actorHue?.step ?? -1}
        occurredAtIso={props.row.timestamp}
        authorLabel={props.row.actor ?? family.label}
        kindLabel={props.row.type}
        isSuperseded={props.isSuperseded}
        footer={isUser ? props.editControl : undefined}
      >
        <div className={`meridian-message-card meridian-message-card--${family.kind}`}>
          <span className="meridian-message-card__family">
            {family.glyph === undefined ? null : <Glyph name={family.glyph} title={family.label} />}
            {family.label}
          </span>
          {isUser ? (
            <UserBody row={props.row} footnotes={props.footnotes} />
          ) : family.kind === "thinking" ? (
            props.thinkingRow
          ) : (
            <MessageContent
              content={props.content}
              {...(props.liveText === undefined ? {} : { liveText: props.liveText })}
              // THE SHAPE THIS CARD DOES HAVE TO GIVE, unlike the tool card beside it.
              // `AssistantOutputPayload` carries the producer's own media type, and the
              // same reading feeds the receipt below — so the renderer a body takes and
              // the type printed under it can never disagree.
              {...(assistantMediaType === undefined ? {} : { contentType: assistantMediaType })}
              sourceId={props.row.id}
              footnotes={props.footnotes}
              label={family.label}
            />
          )}
          <InlineCards cards={props.inlineCards ?? []} />
          {isUser || family.kind === "thinking" || props.liveText !== undefined ? null : (
            <RecordedBodyLine
              contentType={assistantMediaType}
              contentLength={readWireCount(payload, "contentLength")}
            />
          )}
        </div>
      </LedgerRow>
    </TranscriptRowGroup>
  );
}
