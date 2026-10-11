// One static template of Electron's own role menus; the operating system supplies the menus around
// File, Edit, View and Window, the About panel's options and the developer-tools row's keys. The
// View menu carries the color-scheme choice with the one in force ticked, so the template is
// rebuilt whenever the kept scheme changes, and again when a pick is not kept: Electron ticks a
// radio row as it is clicked, and the tick goes back to the scheme in force while main's
// diagnostic log says why and the window used last says so on its banner. About is the system's
// own panel, filled once before the first install with the running app's name and version. A
// development build's View menu also toggles the console document's developer tools in the window
// the row was chosen in, never the focused page's, which can be a Preview page.

import { app, Menu, type MenuItemConstructorOptions } from "electron";

import { SYSTEM_SCHEME_PREFERENCE, type SchemePreference } from "#shared/color-scheme.js";

import type { KeptAppearance } from "./appearance/kept-record.js";
import type { ApplicationMenuParts, MainOperatingSystem } from "./operating-system/contract.js";
import type { OpenWindows } from "./windows/registry.js";
import type { MainDiagnosticLog } from "./services/diagnostic-log.js";
import type { InstallLocation } from "./services/resource-file.js";
import { describeFailure } from "#shared/failure-message.js";

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
 * written to `log` and announced through `openWindows` to the console document, which also opens
 * a window's developer tools in a development build; `location` finds a file the About panel
 * shows, and `operatingSystem` supplies the system's menus and panel options.
 */
export function installApplicationMenu(
  appearance: Pick<KeptAppearance, "scheme" | "chooseScheme" | "subscribe">,
  log: Pick<MainDiagnosticLog, "write">,
  openWindows: Pick<OpenWindows, "announceUnkeptScheme" | "toggleDeveloperTools">,
  location: InstallLocation,
  operatingSystem: Pick<MainOperatingSystem, "applicationMenu">,
): void {
  const menuParts = operatingSystem.applicationMenu;
  app.setAboutPanelOptions({
    applicationName: app.getName(),
    applicationVersion: app.getVersion(),
    ...menuParts.aboutPanelOptions(app.getVersion(), location),
  });
  // Vite's development flag, a literal in the bundle: no other build carries the row.
  const developerToolsRows: MenuItemConstructorOptions[] = import.meta.env.DEV
    ? [
        {
          label: "Toggle Developer Tools",
          accelerator: menuParts.developerToolsAccelerator,
          click: (_menuItem, chosenWindow) => {
            openWindows.toggleDeveloperTools(chosenWindow);
          },
        },
      ]
    : [];
  let tickedScheme = appearance.scheme;
  const install = (): void => {
    tickedScheme = appearance.scheme;
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(
        applicationMenuTemplate(menuParts, appearance, pick, developerToolsRows),
      ),
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
  menuParts: ApplicationMenuParts,
  appearance: Pick<KeptAppearance, "scheme">,
  pick: (scheme: SchemePreference) => void,
  developerToolsRows: readonly MenuItemConstructorOptions[],
): MenuItemConstructorOptions[] {
  return [
    ...menuParts.leadingMenus,
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
        ...developerToolsRows,
      ],
    },
    { role: "windowMenu" },
    ...menuParts.trailingMenus(app.getName()),
  ];
}
