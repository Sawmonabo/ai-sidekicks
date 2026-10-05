// The transcript's diff card, registered for the repos feature.

import { createElement } from "react";

import { type InlineCardRegistry } from "#renderer/registries/inline-cards/inline-card-registry.js";
import { InlineDiffCard } from "../diff/components/InlineDiffCard.js";
import { REPOS_FEATURE_OWNER } from "./owner.js";

/**
 * Fill the transcript row's `diff` card in the registry it is given. The registry is a
 * parameter so an isolated composition writes into its own, and registering from here rather
 * than at the card module's scope means a hot reload re-runs one module.
 */
export function registerReposInlineCards(inlineCardRegistry: InlineCardRegistry): void {
  inlineCardRegistry.register("diff", {
    owner: REPOS_FEATURE_OWNER,
    render: (cardProps) => createElement(InlineDiffCard, { card: cardProps }),
  });
}
