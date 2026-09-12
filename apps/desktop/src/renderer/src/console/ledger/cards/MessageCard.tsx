// The message card — a participant's words, an agent's reply, and an agent's reasoning.
//
// Three of `card-family.ts`'s five families live here and share one layout: the body is
// open, the attribution edge carries the author's hue, and the row's affordances are
// revealed on hover rather than parked in the log, because secondary controls live one
// click away.
//
// WHERE EACH BODY COMES FROM, which is the one thing about this card that is not
// obvious:
//
//   • An ASSISTANT body is machine-authored, so it arrives through the hydrated
//     `content` projection and renders through `MachineBody` — including its truncation
//     and unavailability dispositions, which are `MachineBody`'s and not this card's.
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
// AND A REASONING BODY IS NOT A MACHINE BODY. The reasoning family renders the
// four-arm availability surface rather than the hydrated content projection: those
// are two different reads answering two different questions, and rendering reasoning
// through `MachineBody` made a turn whose reasoning was WITHHELD by policy
// indistinguishable from one whose stored body could not be opened. The element is
// composed by the mount and handed down, for the reason the edit affordance is —
// this card decides layout, and what a row is allowed to show is decided by the
// surface that performed the read.
//
// THE EDIT AFFORDANCE IS A SLOT, NOT A CONTROL THIS FILE WRITES. The pencil that opens
// an inline editor belongs to the plan that owns run controls, and the console never
// re-authors a body another plan owns. `OwnerSlotProps` is the declaration of that
// arrangement, and this card mounts it in the row's hover footer.

import { readWireString } from "../../core/index.js";
import { Glyph, LedgerRow } from "../../primitives/index.js";
import {
  type InlineCardSeatProps,
  type OwnerSlotContract,
  type OwnerSlotProps,
} from "../../seats/index.js";
import { LedgerRowGroup } from "../frame/index.js";
import { classifyCardFamily } from "./card-family.js";
import type { LedgerCardProps } from "./card-props.js";
import { InlineCards } from "./InlineCards.js";
import { MachineBody } from "./bodies/index.js";
import { MessageReceipt } from "./MessageReceipt.js";
import { ParticipantBody } from "./bodies/index.js";
import { projectedPayload, readWireCount } from "./wire-payload.js";

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
  /**
   * The reasoning row's body, composed by the mount.
   *
   * Required and carrying `undefined` rather than optional, on the same terms as the
   * slot above: a mount that composed no reasoning surface for a reasoning row is a
   * compile error at the construction site rather than a row that silently falls back
   * to the machine body and reports a policy redaction as an unreadable one.
   */
  readonly reasoningSurface: React.ReactNode | undefined;
}

export function MessageCard(props: MessageCardProps): React.JSX.Element {
  const family = classifyCardFamily(props.row);
  const isParticipant = family.family === "participant-message";
  const payload = projectedPayload(props.row);
  // Read once for both readers below: the body's renderer and the receipt's own line.
  const assistantMediaType = readWireString(payload["contentType"]);

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
          ) : family.family === "assistant-reasoning" ? (
            props.reasoningSurface
          ) : (
            <MachineBody
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
          {isParticipant ||
          family.family === "assistant-reasoning" ||
          props.liveText !== undefined ? null : (
            <MessageReceipt
              contentType={assistantMediaType}
              contentLength={readWireCount(payload, "contentLength")}
            />
          )}
        </div>
      </LedgerRow>
    </LedgerRowGroup>
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
