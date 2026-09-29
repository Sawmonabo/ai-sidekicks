// The settings pages that exist, in the design's order.
//
// Here with the routes rather than in the settings feature, because a page id is also the
// page's `#/settings/<page>` address segment. Nothing here is a wire shape: a page id names
// a page-list entry and an address, both this renderer's own.

/**
 * Every settings page that is built, in page-list order.
 *
 * The design's ten pages, less Projects and Devices, whose ids are added with their pages.
 */
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

/** One settings page. Derived from the tuple, never restated. */
export type SettingsPageId = (typeof SETTINGS_PAGE_IDS)[number];
