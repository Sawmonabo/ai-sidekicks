// The settings surface's body, and the root of the chunk it arrives in.
//
// THIS FILE IS A SECOND ENTRY POINT INTO THIS FAMILY, and everything about its shape
// follows from that. `index.ts` is the family's door — what a sibling imports — and it
// is reached from the console's initial import graph, because `collaboration-family.ts`
// has to call the registrar before a route can resolve. This module is reached only by
// the registrar's `body` loader, so what it imports is what a person pays for when they
// open settings and never before.
//
// WHICH IS WHY THE TWELVE PAGES AND EVERY STYLESHEET ARE IMPORTED HERE. The pages are
// the family's weight — a dozen forms, their tables, and the combobox stack two of them
// mount — and none of it is reachable except through this surface. `apps/desktop`'s
// stylesheet rule names this exact case: a directory carrying a lazily-loaded chunk has
// an owner of its own, and importing its sheets from the family door would put the rules
// for twelve settings pages on the initial document of every session that never opens
// one.
//
// The registry is composed PER MOUNT rather than at module scope, which keeps the
// property the registrar had while it composed the pages itself: no second window
// inherits this one's page set, and a suite renders against a registry it owns.

import "./settings.css";
import "./shared/settings-page.css";
import "./shared/preference-toggle-row.css";
import "./pages/appearance/appearance.css";
import "./pages/cost/cost-receipt.css";
import "./pages/keyboard/keyboard.css";
import "./pages/mounts/mounts.css";
import "./pages/notifications/notifications.css";

import { createElement, useState } from "react";

import type { ConsoleSurfaceContext } from "../seats/index.js";
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
 * Takes the registry rather than reaching for a module-scope singleton, for
 * `registerConsoleFamilies`' reason: {@link Body} composes the pages its surface renders
 * and holds them for that mount, so a second window composes its own set without a
 * second code path and neither window inherits the other's.
 *
 * NOT EXPORTED. A door line exists for a production reader, and the only caller that
 * could want this page set is one composing a settings surface — which is {@link Body}.
 * A test wanting what a window renders drives the registrar and reads back the render it
 * claimed, rather than composing a second copy of this list that agrees with it until
 * someone adds a page to one of them.
 */
function registerSettingsPages(registry: SettingsPageRegistry): void {
  // T-023p-1C-4 L4.6 nodes, notifications, application
  registerRuntimeNodesPage(registry);
  registerNotificationsPage(registry);
  registerApplicationPage(registry);
  // The sidekicks page: the console root's one-line seam, the agents family's body.
  // It is registered from here and composed there, because naming two view families
  // is a composition site's job and this family names only its own.
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
 * The settings surface, with its pages composed for this mount.
 *
 * `useState` with a lazy initialiser rather than a construction in the render body: the
 * registry is state whose identity the surface reads across every re-render, and the
 * package standard puts a construction in a hook rather than beside the JSX.
 *
 * A `.ts` MODULE COMPOSING WITH `createElement`, like every other chunk root beside it.
 * This file is an entry point rather than a component — it names no component of its
 * own, it holds the family's page roster and its stylesheet edges — and
 * `architecture/one-component-per-module.test.ts` reads a `.tsx` extension as the claim
 * that a module DECLARES the component its filename names. One element in one return is
 * not worth making that claim falsely.
 */
export function Body(context: ConsoleSurfaceContext): React.ReactNode {
  const [pages] = useState(() => {
    const registry = new SettingsPageRegistry();
    registerSettingsPages(registry);
    return registry;
  });
  return createElement(SettingsSurface, { context, pages });
}
