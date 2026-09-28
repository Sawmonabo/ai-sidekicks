// The application menu: one static template of Electron's own role menus, so the
// platform supplies its verbs and their accelerators.

import { Menu, type MenuItemConstructorOptions } from "electron";

const IS_MACOS = process.platform === "darwin";

/**
 * Builds and installs the application menu. Called once, inside
 * `app.whenReady()`, after the renderer protocol is installed and before the
 * main window is created, so a menu accelerator can never fire against an
 * uninstalled scheme.
 */
export function installApplicationMenu(): void {
  const template: MenuItemConstructorOptions[] = [];

  // The macOS application menu (about / services / hide / quit) has no analog on
  // Windows or Linux, where `role: "fileMenu"` carries Quit instead.
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
