// The application menu — Plan-023 Phase 1B (T-023p-1B-2).
//
// `Spec-023 §Main Process Responsibilities` requires a platform-appropriate menu
// bar (macOS app menu; Windows/Linux window menu). This module builds it from a
// template of platform-default roles plus a `Window` submenu whose auxiliary
// entries come from the SHARED implemented-route list in
// `../shared/auxiliary-routes.ts` — never from the route type. The menu-bar path
// is the one that ships first
// because it needs no new bridge namespace: opening an auxiliary window is a
// main-process act, so nothing here crosses the preload boundary. A
// renderer-initiated detach rides the window-control namespace on
// `Plan-023 §Console growth slate`.
//
// Copy follows `Spec-023 §Console Design (Meridian)` §Copy: sentence case, no
// exclamation marks, no capability claimed that the code does not implement.
//
// Implemented-set-derived, and that is the point. Phase 1B ships the
// main-process half of an auxiliary window; the renderer route bodies are Phase
// 1C's T-023p-1C-2 / T-023p-1C-4. An entry offered before its route exists opens
// a hardened window onto a hash route with nothing behind it — a blank frame the
// user has to close, from a menu that claimed it did something. So
// `IMPLEMENTED_AUXILIARY_ROUTES` is empty at Phase 1B and this menu renders no
// auxiliary entry, and each entry appears as its own route body lands in the
// same commit as its entry in that list. That list is shared rather than a
// main-process registry for the reason its own header gives: a renderer route
// module cannot register itself into main-process state, so a registry is a gate
// nothing ever opens.
//
// The `Window` submenu itself is NOT omitted when that list is empty. Its
// other items are `minimize` / `zoom` / `front` / `close` — platform window
// commands that have nothing to do with auxiliary routes and work today.
// Dropping the submenu to hide two entries would take Minimize and Close off
// the menu bar as collateral, which is a regression in a surface Phase 1C does
// not touch. What an empty implemented set removes is exactly the auxiliary
// entries and the separator that introduces them, so the submenu never renders a
// leading or doubled divider around nothing.
//
// Both entries open the BARE route — `createAuxiliaryWindow({ route })` with no
// pane context. A menu bar has no pane to read a session or agent from, and
// guessing one (the most recent session, say) would put a window on a subject
// the user did not choose. The auxiliary renderer's own context picker is
// Phase 1C's; until it lands, a bare window is an honest empty state and not a
// wrong one.
//
// `registerMenuSection` is the second seam (Codex closing round). An owning plan
// EXTENDs this menu with its own section rather than editing this template:
// Plan-026 T7.3 registers the `Session` section's _Set up collaboration_ /
// _Set up providers_ entries through it, gated on this phase merged, which is the
// owner `Plan-026 §Risks And Blockers` names. Sections are a RUNTIME registry
// where routes are a static list, and the difference is not stylistic: a
// section's registrant is a main-process module (Plan-026's walkthrough host),
// so it can call in, whereas a renderer route module cannot. A section whose
// owning plan has nothing to offer registers no items and renders nothing —
// the same absent-not-disabled rule, applied one level up.

import { Menu, type MenuItemConstructorOptions } from "electron";

import {
  AUXILIARY_ROUTE_LABELS,
  IMPLEMENTED_AUXILIARY_ROUTES,
  type AuxiliaryRouteName,
} from "../shared/auxiliary-routes.js";
import { createAuxiliaryWindow } from "./window.js";

const IS_MACOS = process.platform === "darwin";

/**
 * The keyboard shortcut each auxiliary route's menu entry carries.
 *
 * A menu concern, so it lives in the menu. An accelerator is meaningless to the
 * renderer bundle and to the window factory; shipping it through the shared
 * module would put a menu-bar string into a browser bundle that has no menu bar.
 *
 * A TOTAL `Record` over the closed route set, so adding a route is a compile
 * error here until its shortcut is decided — the same forcing function the
 * shared label record and the window factory's geometry record apply at the
 * other two sites a new route needs a decision.
 */
const AUXILIARY_MENU_ACCELERATORS: Record<AuxiliaryRouteName, string> = {
  timeline: "CmdOrCtrl+Shift+T",
  "agent-console": "CmdOrCtrl+Shift+A",
};

/**
 * A top-level submenu an owning plan contributes.
 *
 * `id` is the replace key, so a module that registers on every activation (or on
 * every hot reload) updates its section rather than stacking duplicates of it.
 * `items` is the owner's own list: a section that has nothing to offer registers
 * an empty one and is not rendered at all, which is how an owner applies the
 * absent-not-disabled rule to its own entries without this module knowing
 * anything about them.
 */
export interface MenuSection {
  readonly id: string;
  readonly label: string;
  readonly items: readonly MenuItemConstructorOptions[];
}

/**
 * The section registry and the installed-menu state, encapsulated.
 *
 * A class with private fields rather than a module-level `Map` plus a
 * module-level `let`, because the two are ONE piece of state: whether a
 * registration must rebuild the menu bar depends on whether the menu is already
 * installed, and holding that pair as two free module bindings lets any later
 * edit update one without the other. The class also makes the ordering
 * guarantee legible in one place: `Map` iteration is insertion-ordered, and
 * main-process composition is one sequential act, so registration order is a
 * deterministic order rather than a race.
 *
 * Exactly one instance exists, held in a `const` below. It is module-private:
 * the exported surface is `registerMenuSection` / `installApplicationMenu`, so
 * no caller can reach past them into the registry itself.
 */
class ApplicationMenuRegistry {
  readonly #sections = new Map<string, MenuSection>();
  #installed = false;

  /**
   * Records (or replaces) one section, rebuilding the menu bar when one is
   * already installed.
   *
   * `Menu.setApplicationMenu` is the only way to change an installed template,
   * so a section registered after startup must trigger a rebuild or it never
   * reaches the menu bar. Before install this only records, so a composition
   * root may register in any order.
   */
  public register(section: MenuSection): void {
    this.#sections.set(section.id, section);
    if (this.#installed) {
      this.install();
    }
  }

  /** Builds a fresh template and installs it. */
  public install(): void {
    this.#installed = true;
    Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate()));
  }

  /** The registered sections as menu items, in registration order. */
  public sectionMenuItems(): MenuItemConstructorOptions[] {
    const items: MenuItemConstructorOptions[] = [];
    for (const section of this.#sections.values()) {
      // A section with no entries renders nothing — not an empty submenu, which
      // would be a menu title that opens onto nothing.
      if (section.items.length === 0) {
        continue;
      }
      items.push({ label: section.label, submenu: [...section.items] });
    }
    return items;
  }
}

const applicationMenuRegistry = new ApplicationMenuRegistry();

/**
 * Registers (or replaces) one top-level section.
 *
 * The exported seam Plan-026 T7.3 consumes; see {@link ApplicationMenuRegistry}
 * for the rebuild rule.
 */
export function registerMenuSection(section: MenuSection): void {
  applicationMenuRegistry.register(section);
}

function buildAuxiliaryMenuItems(): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = IMPLEMENTED_AUXILIARY_ROUTES.map((route) => ({
    label: AUXILIARY_ROUTE_LABELS[route],
    accelerator: AUXILIARY_MENU_ACCELERATORS[route],
    click: () => {
      createAuxiliaryWindow({ route });
    },
  }));

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

  template.push(...applicationMenuRegistry.sectionMenuItems());

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

/**
 * Builds and installs the application menu. Called once, inside
 * `app.whenReady()`, after the renderer protocol is installed and before the
 * main window is created — so a menu accelerator can never fire against an
 * uninstalled scheme.
 *
 * Idempotent with respect to state: it installs a freshly built template every
 * time and holds no subscription, so a second call cannot stack listeners or
 * leave a handle behind.
 */
export function installApplicationMenu(): void {
  applicationMenuRegistry.install();
}
