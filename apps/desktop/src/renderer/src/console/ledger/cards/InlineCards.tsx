// The inline cards a message carries — a chip each, and the seat's body under it.
//
// Its own module for the one-component rule. The chip and the body answer different
// questions, which is why they are drawn together here rather than delegated whole:
// the chip is the message's own statement that it carries a diff or an attachment,
// and the body is the part a family that has not landed yet cannot fill.

import { Chip, Nothing } from "../../primitives/index.js";
import {
  inlineCardBody,
  inlineCardSeatRegistry,
  type InlineCardSeatProps,
} from "../../seats/index.js";

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
      return `diff:${card.runId}:${card.diffArtifactId}`;
    case "attachment":
      return `attachment:${card.attachment.attachmentId}`;
    case "artifact":
      return `artifact:${card.artifact.kind}:${card.artifact.id}`;
  }
}

export interface InlineCardsProps {
  readonly cards: readonly InlineCardSeatProps[];
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
export function InlineCards(props: InlineCardsProps): React.JSX.Element | null {
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
