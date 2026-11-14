import type { SettingsControl } from "../../types.js";

/** The switches the Browser page draws that search finds, in the order the page draws them. */
export const BROWSER_CONTROLS: Readonly<
  Record<"rememberSiteData" | "browserToolsForAgents" | "sandboxBackgroundBrowser", SettingsControl>
> = {
  rememberSiteData: { id: "remember-site-data", label: "Remember site data" },
  browserToolsForAgents: {
    id: "browser-tools-for-sidekicks",
    label: "Browser tools for sidekicks",
  },
  sandboxBackgroundBrowser: {
    id: "sandbox-the-background-browser",
    label: "Sandbox the background browser",
  },
};
