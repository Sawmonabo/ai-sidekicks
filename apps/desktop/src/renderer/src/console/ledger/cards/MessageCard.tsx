// The message card — a participant's words, an agent's reply, and an agent's reasoning.
//
// Three of `card-family.ts`'s five families live here and share one layout: the body is
// open, the attribution edge carries the author's hue (`Spec-023 §Meridian, the design
// language` rules 1 and 2), and the row's affordances are revealed on hover rather than
// parked in the log — rule 7's "secondary controls live one click away".
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
              sourceId={props.row.id}
              footnotes={props.footnotes}
              label={family.label}
            />
          )}
          <InlineCards cards={props.inlineCards ?? []} />
          {isParticipant || props.liveText !== undefined ? null : (
            <MessageReceipt
              contentType={readWireString(payload["contentType"])}
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
