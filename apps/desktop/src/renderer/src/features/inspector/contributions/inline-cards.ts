// The inline card the inspector fills in a transcript row: the published-artifact card.

import { createElement } from "react";

import { type InlineCardSeatRegistry } from "@renderer/console/seats/index.js";
import { InlineArtifactCard } from "../artifacts/components/InlineArtifactCard.js";

/** Who owns this body, for the seat registry's owner-scoped duplicate policy. */
const INLINE_ARTIFACT_CARD_OWNER = "inspector";

/**
 * Fill the transcript row's `artifact` card on the board it is given.
 *
 * The board is a parameter rather than an import, so a suite composing one feature in
 * isolation writes into its own registry and never mutates the running window's.
 */
export function registerInspectorInlineCards(inlineCardSeats: InlineCardSeatRegistry): void {
  inlineCardSeats.register("artifact", {
    owner: INLINE_ARTIFACT_CARD_OWNER,
    render: (cardProps) => createElement(InlineArtifactCard, { card: cardProps }),
  });
}
