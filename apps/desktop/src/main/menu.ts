// One static template of Electron's own role menus; the platform supplies the verbs and
// accelerators.

import { Menu, type MenuItemConstructorOptions } from "electron";

const IS_MACOS = process.platform === "darwin";

/**
 * Builds and installs the application menu. Call once, inside `app.whenReady()`, after the
 * renderer protocol is installed, so no accelerator can fire against an uninstalled scheme.
 */
export function installApplicationMenu(): void {
  const template: MenuItemConstructorOptions[] = [];

  // Windows and Linux have no application menu; `fileMenu` carries Quit there.
  if (IS_MACOS) {
    template.push({ role: "appMenu" });
  }

  template.push(
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  );

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
