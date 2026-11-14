// The two providers' sections as `provider.list` sends them, for suites that need the provider
// list: the store's own and any view that names a provider. The scenarios' own reply, so a suite
// and a fixture launch word a provider and its plans alike.

import type { ProviderSection } from "@ai-sidekicks/contracts/provider/settings";

import { PROVIDER_SECTIONS } from "#fixtures/data/provider-list.js";

/** The sections of the two providers the app drives today, in the service's order. */
export function providerSectionsFixture(): readonly ProviderSection[] {
  return PROVIDER_SECTIONS;
}

/**
 * The fixture's section for `provider` under the name `name`, as one `provider.subscribe` message
 * restates it. Throws for a provider the fixture lacks.
 */
export function providerSection(provider: string, name: string): ProviderSection {
  const section = PROVIDER_SECTIONS.find((each) => each.provider === provider);
  if (section === undefined) {
    throw new Error(`The provider fixture has no ${provider}`);
  }
  return { ...section, name };
}
