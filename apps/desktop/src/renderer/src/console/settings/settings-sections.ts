// The settings pages that exist, in the design's order, and what the page list calls them.
//
// A leaf that imports nothing: the page registry and the reservation a loader-backed page
// draws while its chunk arrives both name a page, and a type declared in the registry would
// make the two import each other.
//
// Nothing here is a wire shape. A page id names a page-list entry and a `#/settings/<page>`
// address segment, both of which are this renderer's own.

/**
 * Every settings page that is built, in page-list order.
 *
 * The design's ten pages, less Projects and Devices, whose ids are added with their pages.
 * The union is derived from the tuple, so the two cannot disagree.
 */
export const SETTINGS_SECTION_IDS = [
  "general",
  "providers",
  "mcp-servers",
  "browser",
  "keyboard",
  "appearance",
  "notifications",
  "runtime",
] as const;

/** One settings page. Derived from the enumeration, never restated. */
export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number];

/**
 * The page list's label for each page.
 *
 * A total record, so a new page is a compile error here until its label is decided.
 */
export const SETTINGS_SECTION_LABELS: Readonly<Record<SettingsSectionId, string>> = {
  general: "General",
  providers: "Providers",
  "mcp-servers": "MCP servers",
  browser: "Browser",
  keyboard: "Keyboard",
  appearance: "Appearance",
  notifications: "Notifications",
  runtime: "Runtime",
};
