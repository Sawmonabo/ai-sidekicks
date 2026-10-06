// The inline cards the composer fills on a transcript row.

import { createElement } from "react";

import type { InlineCardRegistry } from "#renderer/registries/inline-cards/registry.js";
import { InlineAttachmentCard } from "../attachments/components/InlineAttachmentCard.js";

const COMPOSER_INLINE_CARD_OWNER = "composer";

/** Register the composer's inline cards in the supplied registry, never the running window's. */
export function registerComposerInlineCards(inlineCardRegistry: InlineCardRegistry): void {
  inlineCardRegistry.register("attachment", {
    owner: COMPOSER_INLINE_CARD_OWNER,
    render: (cardProps) => createElement(InlineAttachmentCard, { card: cardProps }),
  });
}
