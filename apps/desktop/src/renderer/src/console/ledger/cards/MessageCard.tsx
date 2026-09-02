// The message card — a participant's words, an agent's reply, and an agent's reasoning.
//
// `Spec-023 §Console Design (Meridian)` §5.9 puts three of the five card families here
// and gives them one layout: the body is open, the attribution edge carries the author's
// hue, and the row's affordances are revealed on hover rather than parked in the log.
//
// WHERE EACH BODY COMES FROM, which is the one thing about this card that is not
// obvious:
//
//   • An ASSISTANT body is machine-authored, so it arrives through the hydrated
//     `content` projection and renders through `MachineBody` — including its truncation
//     and unavailability dispositions, which are §5.18's and not this card's.
//   • A LIVE assistant body arrives as `liveText`, published by the reveal engine and
//     handed down by the viewport. It takes precedence, because a turn still streaming
//     has no stored body yet.
//   • A PARTICIPANT body arrives as the row's own `summary`, and that is the whole of
//     what the wire carries. `user.message` is a registered event type with NO payload
//     variant: a participant's words are sealed in the per-participant encrypted column
//     and the hydrated content projection covers the machine-authored one. There is no
//     timeline carrier for participant text and no growth-slate row for one, so the card
//     renders what exists rather than reaching for what does not — and never captions
//     the summary as if it were the message.
//
// THE EDIT AFFORDANCE IS A SLOT, NOT A CONTROL THIS FILE WRITES. The pencil that opens
// an inline editor belongs to the plan that owns run controls, and the console never
// re-authors a body another plan owns. `OwnerSlotProps` is the declaration of that
// arrangement, and this card mounts it in the row's hover footer.

import { Chip, Glyph, LedgerRow, Nothing, formatByteQuantity } from "../../primitives/index.js";
import {
  inlineCardBody,
  inlineCardSeatRegistry,
  type InlineCardSeatProps,
  type OwnerSlotContract,
  type OwnerSlotProps,
} from "../../workspace/index.js";
import { LedgerRowGroup } from "../frame/index.js";
import { classifyCardFamily } from "./card-family.js";
import type { LedgerCardProps } from "./card-props.js";
import { MachineBody } from "./MachineBody.js";
import { StreamingMarkdown } from "./StreamingMarkdown.js";
import { projectedPayload, readWireCount, readWireString } from "./wire-payload.js";

/**
 * Who owns the edit affordance, what this card owes it, and when the empty slot dies.
 *
 * Developer-facing and never rendered, which is what `OwnerSlotContract` is for. It
 * names the FEATURE rather than the governance record that plans it, because a string
 * in shipped code is read by whoever opens the file next and the record is read
 * somewhere else entirely.
 */
export const EDIT_AFFORDANCE_SLOT: OwnerSlotContract = {
  owningTask: "the rewind-and-resend edit affordance",
  mountObligation:
    "the hover-revealed footer of a participant message row, given the row and its eligibility",
  deleteShellIn:
    "the change that mounts the affordance — there is no shell to delete, only an empty slot to fill",
};

export interface MessageCardProps extends LedgerCardProps {
  /**
   * The inline cards this message carries.
   *
   * Handed down rather than derived from the row: a message's attachments are not a
   * member of any registered payload — `SteerPayload.attachments` is `unknown[]` by
   * contract — so a card that built these from the wire would be inventing the wire.
   */
  readonly inlineCards?: readonly InlineCardSeatProps[] | undefined;
  /**
   * The edit affordance's slot.
   *
   * Required and carrying `undefined` rather than optional, on `OwnerSlotProps`' own
   * terms: a mount that forgot the slot is then a compile error at the construction
   * site instead of an absent key that renders identically to an unfilled one.
   */
  readonly editAffordance: OwnerSlotProps<React.ReactNode>;
}

export function MessageCard(props: MessageCardProps): React.JSX.Element {
  const family = classifyCardFamily(props.row);
  const isParticipant = family.family === "participant-message";
  const payload = projectedPayload(props.row);

  return (
    <LedgerRowGroup groupLabel="a message row">
      <LedgerRow
        participantHueStep={props.participantHue?.step ?? -1}
        {...(props.participantHue === undefined
          ? {}
          : { ringTreatment: props.participantHue.ringTreatment })}
        occurredAtIso={props.row.timestamp}
        actorLabel={props.row.actor ?? family.label}
        kindLabel={props.row.type}
        isSuperseded={props.isSuperseded}
        footer={isParticipant ? renderEditAffordance(props.editAffordance) : undefined}
      >
        <div className={`meridian-message-card meridian-message-card--${family.family}`}>
          <span className="meridian-message-card__family">
            <Glyph name={family.glyph} title={family.label} />
            {family.label}
          </span>
          {isParticipant ? (
            <ParticipantBody row={props.row} footnotes={props.footnotes} />
          ) : (
            <MachineBody
              content={props.content}
              {...(props.liveText === undefined ? {} : { liveText: props.liveText })}
              kind="prose"
              sourceId={props.row.id}
              footnotes={props.footnotes}
              label={family.label}
            />
          )}
          <InlineCards cards={props.inlineCards ?? []} />
          {isParticipant || props.liveText !== undefined ? null : (
            <MessageReceipt
              contentType={readWireString(payload, "contentType")}
              contentLength={readWireCount(payload, "contentLength")}
            />
          )}
        </div>
      </LedgerRow>
    </LedgerRowGroup>
  );
}

/**
 * A participant's row body.
 *
 * The summary is rendered through the same markdown pipeline an assistant body takes,
 * for one reason: a participant types markdown, and rendering their backticks as
 * backticks in one row and as code in the next would make the log inconsistent about
 * what a message IS. It is passed complete, because a projected summary is not a
 * stream — there is no tail to hold volatile.
 */
function ParticipantBody(props: {
  readonly row: LedgerCardProps["row"];
  readonly footnotes: LedgerCardProps["footnotes"];
}): React.JSX.Element {
  if (props.row.summary === "") {
    return (
      <Nothing
        kind="empty"
        placement="inline"
        title="This message has no summary."
        detail="The participant's own words are not carried on a timeline row."
      />
    );
  }
  return (
    <StreamingMarkdown
      publishedText={props.row.summary}
      sourceId={props.row.id}
      footnotes={props.footnotes}
      isComplete
    />
  );
}

/**
 * The row's hover-revealed footer, or nothing at all.
 *
 * RESERVED, NOT STUBBED — and the empty answer here is silence rather than a named
 * absence, which is the opposite of what a surface-sized slot does. A named absence in
 * every participant row's footer would repeat one sentence about unbuilt work down the
 * whole length of a session's log, which is noise where a mounted surface's absence is
 * information. The declaration above is where the three facts live.
 */
function renderEditAffordance(slot: OwnerSlotProps<React.ReactNode>): React.ReactNode {
  return slot.body;
}

/**
 * The message's inline cards: a chip per card, and the body the repos family registered.
 *
 * The chip renders whether or not a body exists, because the chip is the message's own
 * statement that it carries a diff or an attachment — a fact about the message rather
 * than about which family has landed. The BODY is the part that can be missing, and an
 * unfilled kind says so by name instead of rendering as an empty region a reader would
 * read as an empty diff.
 */
function InlineCards(props: {
  readonly cards: readonly InlineCardSeatProps[];
}): React.JSX.Element | null {
  if (props.cards.length === 0) {
    return null;
  }
  return (
    <div className="meridian-message-card__cards">
      {props.cards.map((card) => (
        <div className="meridian-message-card__card" key={inlineCardKey(card)}>
          <Chip label={card.kind} mono />
          {inlineCardBody(card.kind) === undefined ? (
            <Nothing
              kind="not-checked"
              placement="inline"
              title={`No ${card.kind} card is registered in this window.`}
            />
          ) : (
            inlineCardSeatRegistry.render(card)
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * One card's identity within its message.
 *
 * Narrows on the discriminant rather than reaching for a shared `id` member, because
 * there is not one: each arm carries the identity its own body fetches with, which is
 * `inline-card-seats.ts`' whole reason for being a union rather than a record.
 */
function inlineCardKey(card: InlineCardSeatProps): string {
  switch (card.kind) {
    case "diff":
      return `diff:${card.runId}:${card.changeSetId}`;
    case "attachment":
      return `attachment:${card.attachment.attachmentId}`;
    case "artifact":
      return `artifact:${card.artifact.kind}:${card.artifact.id}`;
  }
}

/**
 * The past-tense receipt a settled machine turn leaves.
 *
 * `Spec-023 §Console Design (Meridian)`'s receipt rule is that an action lands as a
 * record of what happened, so this line reports only what the row itself carries — the
 * body's recorded size and the media type its producer set. It reports no cost and no
 * token count: those are separate metered rows with their own carriers, and a card that
 * summed or restated them would be the second source of truth the cost chokepoint
 * exists to prevent.
 *
 * A turn that carries neither renders no receipt at all, rather than a line saying
 * nothing was recorded — an absence of descriptive members is the ordinary case for a
 * body-less row and not a fact worth a line in the log.
 */
function MessageReceipt(props: {
  readonly contentType: string | undefined;
  readonly contentLength: number | undefined;
}): React.JSX.Element | null {
  if (props.contentType === undefined && props.contentLength === undefined) {
    return null;
  }
  return (
    <p className="meridian-message-card__receipt">
      Recorded
      {props.contentLength === undefined
        ? null
        : ` · ${formatByteQuantity(props.contentLength).text}`}
      {props.contentType === undefined ? null : ` · ${props.contentType}`}
    </p>
  );
}
