// Every provider's section as the background service lists it, one store per app. Its list
// replaces what is held, and each section it delivers after that replaces the one provider it
// names. A section that arrives before the list moves nothing, since the list restates it. A lost
// feed is the store's failed state, never an empty list, which would read as no providers.

import type { ProviderSection } from "@ai-sidekicks/contracts/provider/settings";

import { SharedFeed, type Feed, type FeedFold } from "../shared-feed.js";

/**
 * What the app knows of the providers at one moment: `reading` until the list arrives, the
 * sections in the service's order once it has, or `failed` when the list could not be read.
 */
export type ProviderSectionsState =
  | { readonly status: "reading" }
  | { readonly status: "served"; readonly sections: readonly ProviderSection[] }
  | { readonly status: "failed" };

/**
 * One delivery on the provider feed: the whole list, one provider's whole section as it now
 * stands, or word that the feed could not be read and nothing it holds is to be trusted.
 */
export type ProviderSectionsFrame =
  | { readonly kind: "list"; readonly sections: readonly ProviderSection[] }
  | { readonly kind: "section"; readonly section: ProviderSection }
  | { readonly kind: "lost" };

/** Open the service's provider feed, handing each frame on, until the handle releases it. */
export type ProviderSectionsFeed = Feed<ProviderSectionsFrame>;

/** The providers' sections read from one feed, shared by every reader while any reads. */
export class ProviderSectionsStore extends SharedFeed<
  ProviderSectionsFrame,
  ProviderSectionsState
> {
  public constructor(feed: ProviderSectionsFeed) {
    super(feed, PROVIDER_SECTIONS_FOLD);
  }
}

/** The state after one frame. */
function stateAfter(
  state: ProviderSectionsState,
  frame: ProviderSectionsFrame,
): ProviderSectionsState {
  switch (frame.kind) {
    case "list":
      return { status: "served", sections: frame.sections };
    case "lost":
      return { status: "failed" };
    case "section":
      return state.status === "served"
        ? { status: "served", sections: withSection(state.sections, frame.section) }
        : state;
  }
}

/** Reading until the list arrives, then each frame as `stateAfter` moves it. */
const PROVIDER_SECTIONS_FOLD: FeedFold<ProviderSectionsFrame, ProviderSectionsState> = {
  initial: { status: "reading" },
  open: () => stateAfter,
};

/** The sections with `section` where its provider stood, or at the end for a new provider. */
function withSection(
  sections: readonly ProviderSection[],
  section: ProviderSection,
): readonly ProviderSection[] {
  const at = sections.findIndex((held) => held.provider === section.provider);
  return at < 0 ? [...sections, section] : sections.with(at, section);
}
