// The application menu of a system with no application menu of its own, as on Windows and Linux:
// File carries Quit, About is a row in a Help menu, and the About panel takes the app's icon from
// a file on disk.

import { resolveResourceFile } from "../services/resource-file.js";
import type { ApplicationMenuParts } from "./contract.js";

/** The About panel's icon, which the package's `resources/` folder carries. */
const ABOUT_ICON_FILE = "icon.png";

/**
 * About in a Help menu, its row naming the app since Electron's own reads a bare "About" on
 * Linux; the developer-tools row on Chrome's console keys, as Ctrl+Shift+I is the inspector's
 * while the terminal has focus.
 */
export const ABOUT_IN_HELP_MENU: ApplicationMenuParts = {
  developerToolsAccelerator: "Control+Shift+J",
  aboutPanelOptions: (_version, location) => ({
    iconPath: resolveResourceFile(ABOUT_ICON_FILE, location),
  }),
  leadingMenus: [],
  trailingMenus: (appName) => [
    { role: "help", submenu: [{ role: "about", label: `About ${appName}` }] },
  ],
};
