// One static template of Electron's own role menus; the platform supplies the verbs and
// accelerators. The View menu carries the color-scheme choice with the one in force ticked, so the
// template is rebuilt whenever the kept scheme changes, and again when a pick is not kept: Electron
// ticks a radio row as it is clicked, and the tick goes back to the scheme in force while main's
// diagnostic log says why and the window used last says so on its banner. About is the platform's
// own panel, filled once before the first install with the running app's name and version.

import { app, Menu, type MenuItemConstructorOptions } from "electron";

import { SYSTEM_SCHEME_PREFERENCE, type SchemePreference } from "#shared/appearance.js";

import type { KeptAppearance } from "./appearance/kept-record.js";
import type { OpenWindows } from "./windows/registry.js";
import type { MainDiagnosticLog } from "./services/diagnostic-log.js";
import { resolveResourceFile, type InstallLocation } from "./services/resource-file.js";
import { describeFailure } from "#shared/failure-message.js";

/** The About panel's icon. Windows and Linux take it from a file on disk; macOS from the bundle. */
const ABOUT_ICON_FILE = "icon.png";

/** The View menu's scheme rows, in the order the Appearance page lists them. */
const SCHEME_CHOICES: readonly { readonly scheme: SchemePreference; readonly label: string }[] = [
  { scheme: SYSTEM_SCHEME_PREFERENCE, label: "System" },
  { scheme: "light", label: "Light" },
  { scheme: "dark", label: "Dark" },
];

/**
 * Fills the About panel, builds and installs the application menu, and rebuilds the menu when the
 * kept scheme changes. Call once, inside `app.whenReady()`, after the renderer protocol is
 * installed, so no accelerator can fire against an uninstalled scheme. A pick that is not kept is
 * written to `log` and announced through `openWindows` to the console document; `location` finds
 * the About panel's icon on Windows and Linux.
 */
export function installApplicationMenu(
  appearance: Pick<KeptAppearance, "scheme" | "chooseScheme" | "subscribe">,
  log: Pick<MainDiagnosticLog, "write">,
  openWindows: Pick<OpenWindows, "announceUnkeptScheme">,
  location: InstallLocation,
): void {
  const isMacOS = process.platform === "darwin";
  // macOS shows `version` in parentheses; unset, a development build would show Electron's own.
  app.setAboutPanelOptions({
    applicationName: app.getName(),
    applicationVersion: app.getVersion(),
    ...(isMacOS
      ? { version: app.getVersion() }
      : { iconPath: resolveResourceFile(ABOUT_ICON_FILE, location) }),
  });
  let tickedScheme = appearance.scheme;
  const install = (): void => {
    tickedScheme = appearance.scheme;
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(applicationMenuTemplate(isMacOS, appearance, pick)),
    );
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
      openWindows.announceUnkeptScheme();
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
  isMacOS: boolean,
  appearance: Pick<KeptAppearance, "scheme">,
  pick: (scheme: SchemePreference) => void,
): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [];

  // Windows and Linux have no application menu; `fileMenu` carries Quit there. The roles are
  // spelled out because Electron's own app menu adds Services.
  if (isMacOS) {
    template.push({
      role: "appMenu",
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    });
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

  // On Windows and Linux the row names the app, since Electron's own reads a bare "About" on Linux.
  if (!isMacOS) {
    template.push({
      role: "help",
      submenu: [{ role: "about", label: `About ${app.getName()}` }],
    });
  }

  return template;
}
