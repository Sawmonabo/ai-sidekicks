// The provider names a suite's system messages read: the fixture provider list's own.

import { providerSectionsFixture } from "#renderer/store/providers/sections.test-support.js";
import { providerNameOf } from "#renderer/store/providers/name.js";
import { type ProviderNameOf } from "./kinds.js";

/** A provider's name from the fixture provider list. */
export const fixtureProviderNameOf: ProviderNameOf = (providerId) =>
  providerNameOf(providerSectionsFixture(), providerId);
