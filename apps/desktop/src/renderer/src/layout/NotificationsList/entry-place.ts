// Where pressing a notification entry lands: a session's entry on its session, and a provider's
// new build on that provider's section of Settings › Providers.

import type { AttentionItem } from "@ai-sidekicks/contracts/attention";
import type { AppRoute } from "#renderer/routing/routes.js";
import type { SettingsPageId } from "#renderer/routing/settings-page-ids.js";

/** The place one entry opens. Opening it resolves nothing; the daemon clears an entry. */
export function attentionEntryPlace(item: AttentionItem): AppRoute {
  if (item.trigger === "providerBuild") {
    return { kind: "settings", page: PROVIDERS_PAGE_ID, selection: item.providerBuild.provider };
  }
  return { kind: "session", sessionId: item.sessionId };
}

/** The settings page a provider's section sits on. */
const PROVIDERS_PAGE_ID: SettingsPageId = "providers";
