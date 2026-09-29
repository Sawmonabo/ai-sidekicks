// The notifications page: the frame under the section heading.

import { type ReactNode } from "react";

import type { SettingsPageRegistry } from "@renderer/features/settings/settings-pages.js";

/** The owner this page registers under. */
const OWNER = "settings-notifications";

/** The notifications page: an empty frame under the section heading. */
export function NotificationsPage(): ReactNode {
  return <div className="meridian-settings-page" />;
}

/** Claim the notifications section. */
export function registerNotificationsPage(registry: SettingsPageRegistry): void {
  registry.register({
    section: "notifications",
    owner: OWNER,
    label: "Notifications",
    keywords: [
      "alerts",
      "toasts",
      "mute",
      "attention",
      "interruptions",
      "badges",
      "do not disturb",
    ],
    render: () => <NotificationsPage />,
  });
}
