// The accounts page: an empty frame under the section heading.
//
// The registry and the sign-in flow are `shell/AccountsShell.tsx`, which takes its calls
// as arguments; nothing mounts it until a composition has calls to give.

import type { ReactNode } from "react";

import type { SettingsPageRegistry } from "@renderer/features/settings/settings-pages.js";

/** The owner recorded for this page, so an unfilled section names someone. */
const OWNER = "settings-accounts";

/** Claim the accounts section. */
export function registerProviderAccountsPage(registry: SettingsPageRegistry): void {
  registry.register({
    section: "accounts",
    owner: OWNER,
    label: "Provider accounts",
    keywords: [
      "provider",
      "credentials",
      "sign in",
      "login",
      "billing",
      "quota",
      "rate limit",
      "default account",
      "readiness",
    ],
    render: () => <ProviderAccountsPage />,
  });
}

/** The accounts page: an empty frame under the section heading. */
function ProviderAccountsPage(): ReactNode {
  return <div className="meridian-settings-page" />;
}
