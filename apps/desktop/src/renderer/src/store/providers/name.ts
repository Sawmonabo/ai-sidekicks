// A provider's name as a person reads it, which only the background service's provider list
// holds: the renderer keeps no table of provider names and never branches on a provider's id.

import type { ProviderId } from "@ai-sidekicks/contracts/provider/id";
import type { ProviderSection } from "@ai-sidekicks/contracts/provider/settings";

/**
 * The name `providerId`'s section carries. Throws for an id the sections lack: every id the app
 * holds came from the same service that lists the providers, so a missing one is a defect, never
 * a provider to draw without a name.
 */
export function providerNameOf(
  sections: readonly ProviderSection[],
  providerId: ProviderId,
): string {
  const section = sections.find((held) => held.provider === providerId);
  if (section === undefined) {
    throw new Error(`The provider list holds no provider "${providerId}".`);
  }
  return section.name;
}
