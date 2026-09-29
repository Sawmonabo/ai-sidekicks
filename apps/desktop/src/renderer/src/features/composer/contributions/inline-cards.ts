// The inline cards the composer fills on a transcript row.

import { createElement } from "react";

import type { InlineCardRegistry } from "@renderer/console/seats/index.js";
import { InlineAttachmentCard } from "../attachments/components/InlineAttachmentCard.js";

/** Who owns these bodies, for the registry's owner-scoped duplicate policy. */
const COMPOSER_INLINE_CARD_OWNER = "composer";

/**
 * Register the composer's inline cards in the registry the caller supplies.
 *
 * The registry is a parameter rather than an import, so a composition a test or another
 * window builds writes into its own registry and never into the running window's.
 */
export function registerComposerInlineCards(inlineCardRegistry: InlineCardRegistry): void {
  inlineCardRegistry.register("attachment", {
    owner: COMPOSER_INLINE_CARD_OWNER,
    render: (cardProps) => createElement(InlineAttachmentCard, { card: cardProps }),
  });
}
