// The settings family's door.
//
// The surface, the section vocabulary, and the page registry the four page lanes
// fill. The stylesheet is imported here and nowhere else, so a page can never
// render into a pane whose sheet arrived by accident.
//
// WHY THE PAGE SEAT BOARD LIVES IN THIS FILE
//
// `console/families.ts` gives each VIEW FAMILY a seat and `console/panes/index.ts`
// gives each pane family one. The settings pane has the same problem one level
// further down: four lanes each build two or three pages at once, and a single
// shared call site would make three of them conflict. Same answer, same shape —
// one reserved line per page lane, replaced only by that lane, so four branches
// produce four one-line diffs at four distinct positions.
//
// A page lane reaches the section vocabulary and the descriptor shape by importing
// `settings-page-registry.ts` DEEP, which is what an intra-family import is — this
// door carries only what crosses the family boundary, which is the two registrars
// below.
//
// THE ONE PAGE REGISTERED FROM OUTSIDE THIS FAMILY takes `SettingsPageRegistrar`, a
// one-method view of the registry declared beside it in `settings-page-registry.ts`.
// It is deliberately not re-exported HERE, and the reason is the graph rather than a
// preference: this door imports `../sidekicks-settings-page.js` to compose that page,
// so a type line pointing the other way closes a module cycle and `no-circular` fails.
// The family still declares what crosses its boundary — it is the narrow interface
// and not the registry class — and the page holds `register` and nothing else: no
// rail read, no `unregister`, and no section vocabulary. A lane edits that module for one reason only: the design placed a page in
// settings and named no section id for it, which is why `sidekicks` is there and
// why the other twelve are the design's own.

import "./settings.css";
import "./shared/settings-page.css";

import { createElement } from "react";

import type { ConsoleSurfaceRegistry } from "../frame/surface-registry.js";
import { registerAppearancePage } from "./pages/appearance/AppearancePage.js";
import { registerApplicationPage } from "./pages/application/ApplicationPage.js";
import { registerCostReceiptPage } from "./pages/cost/CostReceiptPage.js";
import { registerDataErasurePage } from "./pages/data-erasure/DataErasurePage.js";
import { registerDiagnosticsPage } from "./pages/diagnostics/DiagnosticsPage.js";
import { registerKeyboardPage } from "./pages/keyboard/KeyboardPage.js";
import { registerMcpServersPage } from "./pages/mcp-servers/McpServersPage.js";
import { registerNotificationsPage } from "./pages/notifications/NotificationsPage.js";
import { registerProviderAccountsPage } from "./pages/provider-accounts/ProviderAccountsPage.js";
import { registerRuntimeNodesPage } from "./pages/runtime-nodes/RuntimeNodesPage.js";
import { registerSidekicksPage } from "../sidekicks-settings-page.js";
import { registerWorkspaceMountsPage } from "./pages/mounts/WorkspaceMountsPage.js";
import { SettingsPageRegistry } from "./settings-page-registry.js";
import { SettingsSurface } from "./SettingsSurface.js";

/**
 * Register every shipped settings page against a registry.
 *
 * Takes the registry rather than reaching for the module-scope singleton, for
 * `registerConsoleFamilies`' reason: a test composes the same pages into a registry
 * it owns, and a second window composes a subset without a second code path.
 */
export function registerSettingsPages(registry: SettingsPageRegistry): void {
  // T-023p-1C-4 L4.6 nodes, notifications, application
  registerRuntimeNodesPage(registry);
  registerNotificationsPage(registry);
  registerApplicationPage(registry);
  // The sidekicks page: the console root's one-line seam, the agents family's body.
  // It is registered from here and composed there, because naming two view families
  // is a composition site's job and this door names only its own.
  registerSidekicksPage(registry);
  // T-023p-1C-4 L4.7 mounts, diagnostics, data, appearance, keyboard
  registerWorkspaceMountsPage(registry);
  registerDiagnosticsPage(registry);
  registerDataErasurePage(registry);
  registerAppearancePage(registry);
  registerKeyboardPage(registry);
  // T-023p-1C-4 L4.8 accounts, MCP servers, cost
  registerProviderAccountsPage(registry);
  registerMcpServersPage(registry);
  registerCostReceiptPage(registry);
}

/**
 * Claim the settings surface slot, and compose the pages it renders.
 *
 * The page registry is built HERE and closed over, rather than reached for at
 * module scope: the pane's contents then depend on this composition rather than on
 * a side effect of it, which is what lets a test render the surface against pages
 * it chose and keeps a second window from inheriting this one's.
 */
export function registerSettingsSurface(registry: ConsoleSurfaceRegistry): void {
  const pages = new SettingsPageRegistry();
  registerSettingsPages(pages);
  registry.register({
    slot: "settings",
    owner: "collaboration-settings",
    render: (context) => createElement(SettingsSurface, { context, pages }),
  });
}
