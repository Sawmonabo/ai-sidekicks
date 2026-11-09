// Every provider's section as the background service lists it, one store per app. The feed opens
// with the first reader and closes with the last; its list replaces what is held, and each section
// it delivers after that replaces the one provider it names. A section that arrives before the list
// moves nothing, since the list restates it. A lost feed is the store's failed state, never an
// empty list, which would read as no providers.

import type { ProviderSection } from "@ai-sidekicks/contracts/provider/settings";

import type { Unsubscribe } from "#shared/preload-api.js";

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

/**
 * Open the service's provider feed, handing each frame on, until the handle releases it. The
 * composition supplies it, so `store/` stays below `services/`.
 */
export type ProviderSectionsFeed = (onFrame: (frame: ProviderSectionsFrame) => void) => Unsubscribe;

/** The providers' sections read from one feed, shared by every reader while any reads. */
export class ProviderSectionsStore {
  readonly #feed: ProviderSectionsFeed;
  readonly #readers = new Set<() => void>();
  #state: ProviderSectionsState = READING;
  #release: Unsubscribe | undefined;

  public constructor(feed: ProviderSectionsFeed) {
    this.#feed = feed;
  }

  /** What readers see now: `reading` until the feed delivers its list. */
  public get state(): ProviderSectionsState {
    return this.#state;
  }

  /** Read the feed until the handle releases it, waking `onChange` each time the state moves. */
  public watch(onChange: () => void): Unsubscribe {
    this.#readers.add(onChange);
    if (this.#readers.size === 1) {
      this.#release = this.#feed((frame) => {
        this.#apply(frame);
      });
    }
    return () => {
      this.#readers.delete(onChange);
      if (this.#readers.size === 0) {
        const release = this.#release;
        this.#release = undefined;
        // A later reader opens the feed afresh, so it reads no list from before.
        this.#state = READING;
        release?.();
      }
    };
  }

  #apply(frame: ProviderSectionsFrame): void {
    const next = stateAfter(this.#state, frame);
    if (next === this.#state) {
      return;
    }
    this.#state = next;
    for (const onChange of [...this.#readers]) {
      onChange();
    }
  }
}

/** What is held before the feed delivers its list. */
const READING: ProviderSectionsState = { status: "reading" };

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

/** The sections with `section` where its provider stood, or at the end for a new provider. */
function withSection(
  sections: readonly ProviderSection[],
  section: ProviderSection,
): readonly ProviderSection[] {
  const at = sections.findIndex((held) => held.provider === section.provider);
  return at < 0 ? [...sections, section] : sections.with(at, section);
}
