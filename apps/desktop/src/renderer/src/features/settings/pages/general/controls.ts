import type { SettingsControl } from "../../types.js";

/** The rows the General page draws that search finds, in the order the page draws them. */
export const GENERAL_CONTROLS: Readonly<
  Record<"version" | "platform" | "architecture" | "locale", SettingsControl>
> = {
  version: { id: "version", label: "Version" },
  platform: { id: "platform", label: "Platform" },
  architecture: { id: "architecture", label: "Architecture" },
  locale: { id: "locale", label: "Locale" },
};
