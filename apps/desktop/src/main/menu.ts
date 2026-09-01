// The application menu — Plan-023 Phase 1B (T-023p-1B-2).
//
// `Spec-023 §Main Process Responsibilities` requires a platform-appropriate menu
// bar (macOS app menu; Windows/Linux window menu). This module builds it from a
// template of platform-default roles plus a `Window` submenu whose auxiliary
// entries are derived from the route registry in `./routes.ts` — never from the
// route type. The menu-bar path is the one that ships first because it needs no
// new bridge namespace: opening an auxiliary window is a main-process act, so
// nothing here crosses the preload boundary. A renderer-initiated detach rides
// the window-control namespace on `Plan-023 §Console growth slate`.
//
// Copy follows `Spec-023 §Console Design (Meridian)` §Copy: sentence case, no
// exclamation marks, no capability claimed that the code does not implement.
//
// Registry-derived, and that is the point. Phase 1B ships the main-process half
// of an auxiliary window; the renderer route bodies are Phase 1C's
// T-023p-1C-2 / T-023p-1C-4. An entry offered before its route exists opens a
// hardened window onto a hash route with nothing behind it — a blank frame the
// user has to close, from a menu that claimed it did something. So Phase 1B
// registers no route and therefore renders no auxiliary entry, and each entry
// appears as its own route lands. This is the same absent-not-disabled rule
// that keeps Plan-026's `Session` entries out (see the note at the end).
//
// The `Window` submenu itself is NOT omitted when no route is registered. Its
// other items are `minimize` / `zoom` / `front` / `close` — platform window
// commands that have nothing to do with auxiliary routes and work today.
// Dropping the submenu to hide two entries would take Minimize and Close off
// the menu bar as collateral, which is a regression in a surface Phase 1C does
// not touch. What an empty registry removes is exactly the auxiliary entries
// and the separator that introduces them, so the submenu never renders a
// leading or doubled divider around nothing.
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

import { auxiliaryRouteRegistry, type AuxiliaryWindowRoute } from "./routes.js";
import { createAuxiliaryWindow } from "./window.js";

const IS_MACOS = process.platform === "darwin";

/**
 * How each auxiliary route presents itself in the `Window` submenu.
 *
 * A total record over the closed route type, so adding a route to that union is
 * a compile error here until its label and accelerator are decided — the label
 * cannot silently default to the route id.
 */
const AUXILIARY_MENU_PRESENTATION: Readonly<
  Record<AuxiliaryWindowRoute, { readonly label: string; readonly accelerator: string }>
> = {
  timeline: { label: "Timeline", accelerator: "CmdOrCtrl+Shift+T" },
  "agent-console": { label: "Agent console", accelerator: "CmdOrCtrl+Shift+A" },
};

function buildAuxiliaryMenuItems(): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [];

  for (const route of auxiliaryRouteRegistry.registered()) {
    const presentation = AUXILIARY_MENU_PRESENTATION[route];
    items.push({
      label: presentation.label,
      accelerator: presentation.accelerator,
      click: () => {
        createAuxiliaryWindow({ route });
      },
    });
  }

  // The separator introduces the auxiliary block, so it belongs to the block
  // and not to the submenu: with nothing to introduce, it is not emitted.
  return items.length === 0 ? [] : [{ type: "separator" }, ...items];
}

function buildMenuTemplate(): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [];

  // The macOS application menu (about / services / hide / quit) has no analog on
  // Windows or Linux, where `role: "fileMenu"` carries Quit instead.
  if (IS_MACOS) {
    template.push({ role: "appMenu" });
  }

  template.push({ role: "fileMenu" }, { role: "editMenu" }, { role: "viewMenu" });

  // Replaces `role: "windowMenu"`, which would supply the platform defaults but
  // no way to add the auxiliary-window entries alongside them.
  template.push({
    label: "Window",
    submenu: [
      { role: "minimize" },
      ...(IS_MACOS ? [{ role: "zoom" } as const] : []),
      ...buildAuxiliaryMenuItems(),
      { type: "separator" },
      ...(IS_MACOS ? [{ role: "front" } as const] : [{ role: "close" } as const]),
    ],
  });

  return template;
}

/** Live registry subscription, so a second install does not stack listeners. */
let unsubscribeFromRegistry: (() => void) | undefined;

/**
 * Builds and installs the application menu. Called once, inside
 * `app.whenReady()`, after the renderer protocol is installed and before the
 * main window is created — so a menu accelerator can never fire against an
 * uninstalled scheme.
 *
 * Also subscribes to the route registry: a route registering after the menu is
 * up rebuilds the menu in place, because `Menu.setApplicationMenu` is the only
 * way to change an installed template and a route that lands mid-session must
 * still reach the menu bar. The registry notifies only on an actual change, so
 * a repeated registration rebuilds nothing.
 */
export function installApplicationMenu(): void {
  unsubscribeFromRegistry?.();
  unsubscribeFromRegistry = auxiliaryRouteRegistry.onChange(() => {
    Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate()));
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate()));
}
