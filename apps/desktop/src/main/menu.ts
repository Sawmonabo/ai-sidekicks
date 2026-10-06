// One static template of Electron's own role menus; the platform supplies the verbs and
// accelerators. The View menu carries the color-scheme choice with the one in force ticked, so the
// template is rebuilt whenever the kept scheme changes, and again when a pick is not kept: Electron
// ticks a radio row as it is clicked, and the tick goes back to the scheme in force while main's
// diagnostic log says why.

import { Menu, type MenuItemConstructorOptions } from "electron";

import { SYSTEM_SCHEME_PREFERENCE, type SchemePreference } from "#shared/appearance.js";

import type { KeptAppearance } from "./appearance/kept-record.js";
import type { MainDiagnosticLog } from "./services/diagnostic-log.js";
import { describeFailure } from "./services/failure-message.js";

const IS_MACOS = process.platform === "darwin";

/** The View menu's scheme rows, in the order the Appearance page lists them. */
const SCHEME_CHOICES: readonly { readonly scheme: SchemePreference; readonly label: string }[] = [
  { scheme: SYSTEM_SCHEME_PREFERENCE, label: "System" },
  { scheme: "light", label: "Light" },
  { scheme: "dark", label: "Dark" },
];

/**
 * Builds and installs the application menu, and rebuilds it when the kept scheme changes. Call
 * once, inside `app.whenReady()`, after the renderer protocol is installed, so no accelerator can
 * fire against an uninstalled scheme. A pick that is not kept is written to `log`.
 */
export function installApplicationMenu(
  appearance: Pick<KeptAppearance, "scheme" | "chooseScheme" | "subscribe">,
  log: Pick<MainDiagnosticLog, "write">,
): void {
  let tickedScheme = appearance.scheme;
  const install = (): void => {
    tickedScheme = appearance.scheme;
    Menu.setApplicationMenu(Menu.buildFromTemplate(applicationMenuTemplate(appearance, pick)));
  };
  const pick = (scheme: SchemePreference): void => {
    appearance.chooseScheme(scheme).catch((failure: unknown) => {
      log.write({
        level: "error",
        source: "main/menu",
        message:
          `the View menu's ${scheme} color scheme was not kept, so ${appearance.scheme} stays: ` +
          describeFailure(failure),
      });
      install();
    });
  };
  install();
  // The record also changes with the text size, the width and the theme, which the menu omits.
  appearance.subscribe(() => {
    if (appearance.scheme !== tickedScheme) {
      install();
    }
  });
}

function applicationMenuTemplate(
  appearance: Pick<KeptAppearance, "scheme">,
  pick: (scheme: SchemePreference) => void,
): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [];

  // Windows and Linux have no application menu; `fileMenu` carries Quit there.
  if (IS_MACOS) {
    template.push({ role: "appMenu" });
  }

  template.push(
    { role: "fileMenu" },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        ...SCHEME_CHOICES.map(
          ({ scheme, label }): MenuItemConstructorOptions => ({
            label,
            type: "radio",
            checked: appearance.scheme === scheme,
            click: () => {
              pick(scheme);
            },
          }),
        ),
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  );

  return template;
}
