// The providers' sections a view draws, from the app's one provider store. The app holds every
// screen back until the list has been read, so a view only ever finds it served or failed; a
// failed list throws to the view's error boundary, which draws its line with `Try again`.

import { createContext, useContext, type Context } from "react";

import type { ProviderSection } from "@ai-sidekicks/contracts/provider/settings";

import { RereadableRefusalError, refuse } from "#renderer/lib/refusal/contract.js";
import type { ProviderSectionsState } from "../sections.js";
import type { ProviderSectionsReading } from "./useProviderSectionsState.js";

/** The app's provider store reading, provided above every window. */
export const ProviderSectionsContext: Context<ProviderSectionsReading | undefined> = createContext<
  ProviderSectionsReading | undefined
>(undefined);

/**
 * Every provider's section, in the service's order. Throws a `RereadableRefusalError` where the
 * list could not be read, and an `Error` where no list is provided or it has not been read yet.
 */
export function useProviderSections(): readonly ProviderSection[] {
  return servedSections(useContext(ProviderSectionsContext)).sections;
}

function servedSections(
  reading: ProviderSectionsReading | undefined,
): Extract<ProviderSectionsState, { readonly status: "served" }> {
  if (reading === undefined || reading.state.status === "reading") {
    throw new Error("Read the providers' sections only under a served provider list.");
  }
  if (reading.state.status === "failed") {
    throw new RereadableRefusalError(
      refuse("provider-list", "provider-list-unread", "Couldn't load providers"),
      reading.readAgain,
    );
  }
  return reading.state;
}
