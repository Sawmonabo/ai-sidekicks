// The settings family's door.
//
// It carries ONE symbol, the surface registrar, because that is all that crosses this
// family's boundary: `collaboration-family.ts` claims the slot and nothing else outside
// this directory names a settings page, a section, or the page registry.
//
// WHAT USED TO BE HERE AND IS NOT. The twelve page registrars, the page-registry
// composition, and every stylesheet in this family moved to
// `settings-surface-body.ts`, the root of the chunk the registrar's loader fetches.
// The reason is the initial import graph: this door is reached before any route
// resolves, so anything it imports is paid for by a session that never opens settings —
// and the settings pages are the largest thing in this family by a wide margin. The
// stylesheet rule in `apps/desktop/AGENTS.md` names the same case from the other side: a
// directory carrying a lazily-loaded chunk has an owner of its own, and that chunk's
// root is where its sheets enter.
//
// WHY THE PAGE SEAT BOARD IS NOT A CALL SITE HERE
//
// `console/families.ts` gives each VIEW FAMILY a seat and `console/panes/index.ts`
// gives each pane family one. The settings pane has the same problem one level further
// down: four lanes each build two or three pages at once, and a single shared call site
// would make three of them conflict. Same answer, same shape — one reserved line per
// page lane, replaced only by that lane — and it lives in the chunk root beside the
// pages it composes.
//
// A page lane reaches the section vocabulary and the descriptor shape by importing
// `settings-page-registry.ts` DEEP, which is what an intra-family import is.
//
// THE ONE PAGE REGISTERED FROM OUTSIDE THIS FAMILY takes `SettingsPageRegistrar`, a
// one-method view of the registry declared beside it in `settings-page-registry.ts`.
// It is deliberately not re-exported HERE: the chunk root imports
// `../sidekicks-settings-page.js` to compose that page, so a type line pointing the
// other way closes a module cycle and `no-circular` fails. The family still declares
// what crosses its boundary — it is the narrow interface and not the registry class —
// and the page holds `register` and nothing else: no rail read, no `unregister`, and no
// section vocabulary. A lane edits that module for one reason only: the design placed a
// page in settings and named no section id for it, which is why `sidekicks` is there and
// why the other twelve are the design's own.

import type { ConsoleSurfaceRegistry } from "../seats/index.js";

/**
 * Claim the settings surface slot.
 *
 * A LOADER AND NOT A `render`. Settings is reached by pressing a rail destination, so
 * nothing paints it before a person asks for it, and every page it composes — twelve
 * forms, their tables, the combobox stack two of them mount, and eight stylesheets —
 * rides the chunk `settings-surface-body.ts` roots rather than the initial import
 * graph. `apps/desktop/AGENTS.md` states the rule beside the seat-board one.
 *
 * The page registry moved behind that boundary with them and is composed there, per
 * mount: composing it here would mean importing all twelve pages from this door, which
 * is the whole of what the boundary exists to defer.
 */
export function registerSettingsSurface(registry: ConsoleSurfaceRegistry): void {
  registry.register({
    slot: "settings",
    owner: "collaboration-settings",
    body: () => import("./settings-surface-body.js"),
  });
}
