// The anchor a page body puts on a control so a link or a search hit can land on it.

import type { SettingsControl } from "../types.js";

/**
 * The attribute a page body sets on the element it draws for a findable control; its value is
 * that control's `id`, as the page's controls declare it.
 */
export const SETTINGS_CONTROL_ATTRIBUTE = "data-settings-control";

/** The attribute to spread on the element a page draws for `control`, so a landing finds it. */
export function settingsControlAnchor(
  control: SettingsControl,
): Readonly<Record<typeof SETTINGS_CONTROL_ATTRIBUTE, string>> {
  return { [SETTINGS_CONTROL_ATTRIBUTE]: control.id };
}
