// Which class a settings page action wears for the tone it carries.
//
// The one thing the settings family kept when the confirming dialog moved to
// `primitives/ConfirmationDialog.tsx`. The dialog owns the parts and the confirming
// button's look; a TRIGGER is a control in this family's own action row and wears this
// family's action class, or it reads as a different kind of control sitting beside its
// neighbours.
//
// A TABLE RATHER THAN A TEMPLATE STRING at each call site: two pages open a
// confirmation — the update restart and the recovery prompt — and a `--${tone}` written
// twice is two places a fourth tone has to be remembered. Total over the vocabulary, so
// a tone the primitive adds is a compile error here rather than a button with no rules.

import type { ConfirmationTone } from "../../primitives/index.js";

const ACTION_TONE_CLASSES: Readonly<Record<ConfirmationTone, string>> = {
  neutral: "meridian-settings-page__action",
  primary: "meridian-settings-page__action meridian-settings-page__action--primary",
  destructive: "meridian-settings-page__action meridian-settings-page__action--destructive",
};

/** The settings action row's class for one tone. */
export function settingsActionClassFor(tone: ConfirmationTone): string {
  return ACTION_TONE_CLASSES[tone];
}
