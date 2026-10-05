// The inline cards a message carries: a chip each, and the body registered for that kind.

import { Chip } from "#renderer/components/Chip/Chip.js";
import {
  inlineCardRegistry,
  type InlineCardProps,
} from "#renderer/registries/inline-cards/inline-card-registry.js";

/** The cards one message carries. */
export interface InlineCardsProps {
  readonly cards: readonly InlineCardProps[];
}

/**
 * The message's inline cards: a chip per card, and the body registered for its kind. The chip
 * renders whether or not a body exists, since it states that the message carries the card; a
 * kind nobody has filled draws no body.
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
          {inlineCardRegistry.render(card)}
        </div>
      ))}
    </div>
  );
}

/**
 * One card's identity within its message. Narrows on the discriminant because there is no shared
 * `id` member: each arm carries the identity its own body fetches with.
 */
function inlineCardKey(card: InlineCardProps): string {
  switch (card.kind) {
    case "diff":
      return `diff:${card.runId}:${card.diffArtifactId}`;
    case "attachment":
      return `attachment:${card.attachment.attachmentId}`;
    case "artifact":
      return `artifact:${card.artifact.kind}:${card.artifact.id}`;
  }
}
