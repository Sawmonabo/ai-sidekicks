import type { SettingsPageId } from "#renderer/routing/settings-page-ids.js";

/**
 * The page list's label for each settings page.
 *
 * A total record, so a new page is a compile error here until its label is decided.
 */
export const SETTINGS_PAGE_LABELS: Readonly<Record<SettingsPageId, string>> = {
  general: "General",
  providers: "Providers",
  "mcp-servers": "MCP servers",
  projects: "Projects",
  browser: "Browser",
  keyboard: "Keyboard",
  appearance: "Appearance",
  notifications: "Notifications",
  runtime: "Runtime",
  devices: "Devices",
};
