// The settings pages that exist, in the design's order. Kept with the routes because a page id
// is also the page's `#/settings/<page>` address segment.

/** Every settings page that is built, in page-list order. */
export const SETTINGS_PAGE_IDS = [
  "general",
  "providers",
  "mcp-servers",
  "browser",
  "keyboard",
  "appearance",
  "notifications",
  "runtime",
] as const;

/** One settings page, derived from `SETTINGS_PAGE_IDS`. */
export type SettingsPageId = (typeof SETTINGS_PAGE_IDS)[number];
