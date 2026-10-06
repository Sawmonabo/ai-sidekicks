// The settings pages that exist, in the order Settings lists them. Kept with the routes because a
// page id is also the page's `#/settings/<page>` address segment.

/** Every settings page, in page-list order: a closed set the list always draws whole. */
export const SETTINGS_PAGE_IDS = [
  "general",
  "providers",
  "mcp-servers",
  "projects",
  "browser",
  "keyboard",
  "appearance",
  "notifications",
  "runtime",
  "devices",
] as const;

/** One settings page, derived from `SETTINGS_PAGE_IDS`. */
export type SettingsPageId = (typeof SETTINGS_PAGE_IDS)[number];
