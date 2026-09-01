// The application menu — Plan-023 Phase 1B (T-023p-1B-2).
//
// `Spec-023 §Main Process Responsibilities` requires a platform-appropriate menu
// bar (macOS app menu; Windows/Linux window menu). This module builds it once
// from a template of platform-default roles plus a `Window` submenu carrying the
// two auxiliary-window entries and their accelerators. The menu-bar path is the
// one that ships first because it needs no new bridge namespace: opening an
// auxiliary window is a main-process act, so nothing here crosses the preload
// boundary. A renderer-initiated detach rides the window-control namespace on
// `Plan-023 §Console growth slate`.
//
// Copy follows `Spec-023 §Console Design (Meridian)` §Copy: sentence case, no
// exclamation marks, no capability claimed that the code does not implement.
//
// Both entries open the BARE route — `createAuxiliaryWindow({ route })` with no
// pane context. A menu bar has no pane to read a session or agent from, and
// guessing one (the most recent session, say) would put a window on a subject
// the user did not choose. The auxiliary renderer's own context picker is
// Phase 1C's; until it lands, a bare window is an honest empty state and not a
// wrong one.
//
// NOT here yet, and deliberately: the `Session` submenu entries
// _Set up collaboration_ and _Set up providers_ that `Spec-026 §Trigger` and
// `Spec-026 §Interfaces And Contracts` name. Plan-026's walkthrough host exports
// the activation entry point those items call, and that host does not exist yet.
// Under the console's absent-not-disabled rule an entry with no route is not
// rendered at all, so both stay out of this template until Plan-026's desktop
// step lands — at which point they become two menu items calling that entry
// point, which is a caller change and not a redesign
// (`Plan-026 §Risks And Blockers`, closed 2026-09-01).

import { Menu, type MenuItemConstructorOptions } from "electron";

import { createAuxiliaryWindow } from "./window.js";

const IS_MACOS = process.platform === "darwin";

function buildMenuTemplate(): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [];

  // The macOS application menu (about / services / hide / quit) has no analog on
  // Windows or Linux, where `role: "fileMenu"` carries Quit instead.
  if (IS_MACOS) {
    template.push({ role: "appMenu" });
  }

  template.push({ role: "fileMenu" }, { role: "editMenu" }, { role: "viewMenu" });

  // Replaces `role: "windowMenu"`, which would supply the platform defaults but
  // no way to add the two auxiliary-window entries alongside them.
  template.push({
    label: "Window",
    submenu: [
      { role: "minimize" },
      ...(IS_MACOS ? [{ role: "zoom" } as const] : []),
      { type: "separator" },
      {
        label: "Timeline",
        accelerator: "CmdOrCtrl+Shift+T",
        click: () => {
          createAuxiliaryWindow({ route: "timeline" });
        },
      },
      {
        label: "Agent console",
        accelerator: "CmdOrCtrl+Shift+A",
        click: () => {
          createAuxiliaryWindow({ route: "agent-console" });
        },
      },
      { type: "separator" },
      ...(IS_MACOS ? [{ role: "front" } as const] : [{ role: "close" } as const]),
    ],
  });

  return template;
}

/**
 * Builds and installs the application menu. Called once, inside
 * `app.whenReady()`, after the renderer protocol is installed and before the
 * main window is created — so a menu accelerator can never fire against an
 * uninstalled scheme.
 */
export function installApplicationMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate()));
}
