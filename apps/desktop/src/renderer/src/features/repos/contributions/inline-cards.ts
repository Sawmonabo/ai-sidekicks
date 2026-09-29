// The inline card the repos feature fills in a transcript row: the diff card.

import { createElement } from "react";

import { type InlineCardRegistry } from "@renderer/console/seats/index.js";
import { InlineDiffCard } from "../diff/components/InlineDiffCard.js";
import { REPOS_FEATURE_OWNER } from "./owner.js";

/**
 * Fill the transcript row's `diff` card on the board it is given.
 *
 * The board is a parameter rather than an import, so an independent composition (a suite
 * composing one feature in isolation) writes into its own registry and never mutates the
 * running window's. Registered from here rather than at the card module's scope, so a
 * hot reload re-runs one module.
 */
export function registerRepos(inlineCardSeats: InlineCardRegistry): void {
  inlineCardSeats.register("diff", {
    owner: REPOS_FEATURE_OWNER,
    render: (cardProps) => createElement(InlineDiffCard, { card: cardProps }),
  });
}
