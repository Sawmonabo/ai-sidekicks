// The providers' sections a view draws, from the app's one provider store. The app holds every
// screen back until the list has been read, so a view only ever finds it served or failed; a
// failed list throws to the view's error boundary, which says the region could not be drawn.

import { createContext, useContext, type Context } from "react";

import type { ProviderSection } from "@ai-sidekicks/contracts/provider/settings";

import { RefusalError, refuse } from "#renderer/lib/refusal/contract.js";
import type { ProviderSectionsState } from "../sections.js";

/** The app's provider store state, provided above every window. */
export const ProviderSectionsContext: Context<ProviderSectionsState | undefined> = createContext<
  ProviderSectionsState | undefined
>(undefined);

/**
 * Every provider's section, in the service's order. Throws a `RefusalError` where the list could
 * not be read, and an `Error` where no list is provided or it has not been read yet.
 */
export function useProviderSections(): readonly ProviderSection[] {
  const state = useContext(ProviderSectionsContext);
  if (state === undefined || state.status === "reading") {
    throw new Error("Read the providers' sections only under a served provider list.");
  }
  if (state.status === "failed") {
    throw new RefusalError(
      refuse("provider-list", "provider-list-unread", "The providers could not be read."),
    );
  }
  return state.sections;
}
