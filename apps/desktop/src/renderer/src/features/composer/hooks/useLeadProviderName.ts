// The name a person reads for the session's lead's provider, from the service's provider list.

import { useMemo } from "react";

import { useProviderSections } from "#renderer/store/providers/hooks/useProviderSections.js";
import { providerNameOf } from "#renderer/store/providers/name.js";
import { useSessionStore } from "#renderer/store/session/hooks/useOpenSessionStore.js";
import { selectStandingEvents } from "#renderer/store/session/selectors.js";
import type { SessionStore } from "#renderer/store/session/store.js";
import { readLeadProviderId } from "../target.js";

/** The lead's provider's name, `undefined` until the session's events name its provider. */
export function useLeadProviderName(sessionStore: SessionStore): string | undefined {
  const standingEvents = useSessionStore(sessionStore, selectStandingEvents);
  const sections = useProviderSections();
  const providerId = useMemo(() => readLeadProviderId(standingEvents), [standingEvents]);
  return providerId === undefined ? undefined : providerNameOf(sections, providerId);
}
