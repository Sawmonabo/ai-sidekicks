// The inline card the repos feature fills in a transcript row: the diff card.

import { createElement } from "react";

import { type InlineCardRegistry } from "@renderer/registries/inline-cards/inline-card-registry.js";
import { InlineDiffCard } from "../diff/components/InlineDiffCard.js";
import { REPOS_FEATURE_OWNER } from "./owner.js";

/**
 * Fill the transcript row's `diff` card in the registry it is given.
 *
 * The registry is a parameter rather than an import, so an independent composition (a suite
 * composing one feature in isolation) writes into its own registry and never mutates the
 * running window's. Registered from here rather than at the card module's scope, so a
 * hot reload re-runs one module.
 */
export function registerReposInlineCards(inlineCardRegistry: InlineCardRegistry): void {
  inlineCardRegistry.register("diff", {
    owner: REPOS_FEATURE_OWNER,
    render: (cardProps) => createElement(InlineDiffCard, { card: cardProps }),
  });
}
