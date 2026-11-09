// A provider's name as a person reads it, for a view.

import type { ProviderId } from "@ai-sidekicks/contracts/provider/id";

import { providerNameOf } from "../name.js";
import { useProviderSections } from "./useProviderSections.js";

/** The name the service's list gives `providerId`; throws as `providerNameOf` does. */
export function useProviderName(providerId: ProviderId): string {
  return providerNameOf(useProviderSections(), providerId);
}
