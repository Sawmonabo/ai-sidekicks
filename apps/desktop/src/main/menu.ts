// One static template of Electron's own role menus; the platform supplies the verbs and
// accelerators. The View menu carries the color-scheme choice with the one in force ticked, so the
// template is rebuilt whenever the kept appearance changes, and again when a pick is not kept:
// Electron ticks a radio row as it is clicked, and the tick goes back to the scheme in force
// while main's diagnostic log says why.

import { Menu, type MenuItemConstructorOptions } from "electron";

import { SYSTEM_SCHEME_PREFERENCE, type SchemePreference } from "@shared/appearance.js";

import type { KeptAppearance } from "./appearance/kept-appearance.js";
import type { MainDiagnosticLog } from "./services/diagnostic-log.js";

const IS_MACOS = process.platform === "darwin";

/** Where a View-menu pick that was not kept is reported. */
export interface MenuFailureReport {
  readonly log: Pick<MainDiagnosticLog, "write">;
  readonly now: () => Date;
}

/** The View menu's scheme rows, in the order the Appearance page lists them. */
const SCHEME_CHOICES: readonly { readonly scheme: SchemePreference; readonly label: string }[] = [
  { scheme: SYSTEM_SCHEME_PREFERENCE, label: "System" },
  { scheme: "light", label: "Light" },
  { scheme: "dark", label: "Dark" },
];

/**
 * Builds and installs the application menu, and rebuilds it on every appearance change. Call
 * once, inside `app.whenReady()`, after the renderer protocol is installed, so no accelerator can
 * fire against an uninstalled scheme.
 */
export function installApplicationMenu(
  appearance: Pick<KeptAppearance, "scheme" | "chooseScheme" | "subscribe">,
  report: MenuFailureReport,
): void {
  const install = (): void => {
    Menu.setApplicationMenu(Menu.buildFromTemplate(applicationMenuTemplate(appearance, pick)));
  };
  const pick = (scheme: SchemePreference): void => {
    appearance.chooseScheme(scheme).catch((failure: unknown) => {
      report.log.write({
        at: report.now().toISOString(),
        level: "error",
        source: "main/menu",
        message:
          `the View menu's ${scheme} color scheme was not kept, so ${appearance.scheme} stays: ` +
          `${failure instanceof Error ? failure.message : String(failure)}`,
      });
      install();
    });
  };
  install();
  appearance.subscribe(install);
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
