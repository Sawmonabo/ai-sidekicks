// The settings page table: which page holds which section, and how a term finds it.
//
// The screen is a page list and a pane holding the selected page. Every entry declares a
// section, a label, keyword aliases and its renderer, so a search hit names where it
// landed. `SETTINGS_PAGES` is the table; `SettingsPageRegistry` is what one mount of the
// screen composes from it, so no window inherits another's pages.
//
// The matcher is `scoreSubsequence` from `@ai-sidekicks/search-ranking`, the one the
// palette ranks with, so a term ranks identically in both places. What lives here is only
// what text a settings entry offers the scorer.

import { createElement } from "react";

import { KeyedRegistry } from "@renderer/lib/keyed-registry.js";
import { scoreSubsequence } from "@ai-sidekicks/search-ranking";
import { LoaderBackedBody, type LazyBodyLoader } from "@renderer/console/seats/index.js";
import { PendingSettingsPage } from "./components/PendingSettingsPage.js";
import { AppearancePage } from "./pages/appearance/AppearancePage.js";
import { GeneralPage } from "./pages/general/GeneralPage.js";
import { KeyboardPage } from "./pages/keyboard/KeyboardPage.js";
import { McpServersPage } from "./pages/mcp-servers/McpServersPage.js";
import { NotificationsPage } from "./pages/notifications/NotificationsPage.js";
import { ProvidersPage } from "./pages/providers/ProvidersPage.js";
import { RuntimePage } from "./pages/runtime/RuntimePage.js";
import type { SettingsPageBody, SettingsPageContext } from "./types.js";
import { SETTINGS_PAGE_IDS, type SettingsPageId } from "@renderer/routing/settings-page-ids.js";
import { SETTINGS_PAGE_LABELS } from "@renderer/features/settings/settings-page-labels.js";

/** One registered page, as the page list, the pane and search read it. */
export interface SettingsPageDescriptor {
  readonly section: SettingsPageId;
  /** Who registered the page. Only the same owner may replace it. */
  readonly owner: string;
  /** The page's own heading. The rail shows {@link SETTINGS_PAGE_LABELS}. */
  readonly label: string;
  /**
   * Alternative terms a person may type for this page.
   *
   * The entry is matched on its label AND on each alias, best score wins, so
   * "shortcut" finds the keyboard page whose label says "Keyboard".
   */
  readonly keywords: readonly string[];
  readonly render: SettingsPageBody;
}

/**
 * One entry of the page table, in one of exactly two forms.
 *
 * THE PANE LAYOUT'S AND THE FRAME'S OWN UNION, applied to a rail section, decided by the same
 * product fact and normalized by the same `LoaderBackedBody`. `registries/panes/pane-registry.ts`
 * states the reasoning; what makes it apply here is that a settings page is not painted
 * before a person acts — settings is a destination somebody navigates to, and a section
 * inside it is a second act after that.
 *
 * IT IS NOT MERELY A SIZE QUESTION, and the case that forced this arm shows why. The
 * agent definitions page's body is the agents feature's, and that feature's public entry is imported
 * EAGERLY by `app/registrations.ts` for the Agents pane's pane registration. So
 * while this registry took only a `render`, the registration site had to reach the page
 * through that entry, and the bundler — which assigns a module reachable both statically
 * and dynamically to the static chunk — put the page and its stylesheet on the initial
 * graph of every launch, including every launch that never opens settings. A loader here
 * is what lets the registration name a chunk root instead of a component.
 *
 * A UNION AND NOT TWO OPTIONAL MEMBERS, for the pane board's reason: `render?` beside
 * `body?` makes "both" and "neither" representable, and both would have to be answered at
 * run time by a registry that cannot know which the page meant.
 */
export type SettingsPageRegistration =
  | (SettingsPageRegistrationBase & {
      readonly render: SettingsPageBody;
      readonly body?: never;
    })
  | (SettingsPageRegistrationBase & {
      readonly body: LazyBodyLoader<SettingsPageContext>;
      readonly render?: never;
    });

/** One ranked search hit: the entry, the text that matched, and its score. */
export interface SettingsPageMatch {
  readonly descriptor: SettingsPageDescriptor;
  /** The label or alias the score was earned on, so the result can say why. */
  readonly matchedText: string;
  readonly score: number;
}

/**
 * The pages one mount of the Settings screen holds, keyed by section.
 *
 * A second claim on a section by a different owner throws rather than replacing it.
 */
export class SettingsPageRegistry {
  // `"owner-scoped"`, for `registries/screens/screen-registry.ts`'s reason: a hot reload re-runs
  // the owner's module and must replace, while two owners on one section is a
  // conflict rather than a swap decided by module import order.
  readonly #descriptorsBySection = new KeyedRegistry<SettingsPageId, SettingsPageDescriptor>({
    duplicatePolicy: "owner-scoped",
    describeWhat: "settings section",
    ownerOf: (descriptor) => descriptor.owner,
    duplicateHint: "the settings pane renders one page per section, in rail order",
  });

  /**
   * The loader-backed pages, so {@link preload} has something to resolve.
   *
   * A second table rather than a member on the descriptor, for the pane and screen registries'
   * reason: the descriptor is what every mount site reads and none of them has business
   * knowing whether the page it is about to render arrived as a chunk.
   */
  readonly #loadedBodiesBySection = new Map<
    SettingsPageId,
    LoaderBackedBody<SettingsPageContext>
  >();

  /**
   * Claim a section. A second claim by a different owner is an error, not a swap.
   *
   * A loader-form registration is normalized here exactly as the pane layout's and the frame's
   * boards normalize theirs: one `LoaderBackedBody` per registration — one memoized promise
   * and one stable lazy component — and a descriptor whose `render` mounts it. So
   * `descriptorFor` answers the same shape for both forms, `entries` ranks both the same
   * way, and neither `SettingsPane` nor the search index branches on how a body arrived.
   *
   * The two writes are ordered as the pane board's are, and for the measured reason that
   * board records: the descriptor is registered FIRST so a refusal — a different owner
   * claiming a taken section — throws before the loader table is touched, and cannot
   * strip the loader off the registration that survives it.
   */
  public register(registration: SettingsPageRegistration): void {
    const descriptorBase = {
      section: registration.section,
      owner: registration.owner,
      label: registration.label,
      keywords: registration.keywords,
    };
    if (registration.body === undefined) {
      this.#descriptorsBySection.register(registration.section, {
        ...descriptorBase,
        render: registration.render,
      });
      this.#loadedBodiesBySection.delete(registration.section);
      return;
    }
    // The fallback is the page region's own empty reservation, supplied here rather than
    // by the generic machinery: what a settings page reserves while it loads is a
    // settings-shaped question, and the pane above it has already drawn the heading.
    const loadedBody = new LoaderBackedBody(registration.body, () =>
      createElement(PendingSettingsPage, { section: registration.section }),
    );
    this.#descriptorsBySection.register(registration.section, {
      ...descriptorBase,
      render: loadedBody.render,
    });
    this.#loadedBodiesBySection.set(registration.section, loadedBody);
  }

  /**
   * Start this section's body loading, without opening it.
   *
   * The pane and screen registries' `preload`: idempotent by construction, because the promise
   * is memoized on the registration, and a component-form or unregistered section settles
   * immediately with nothing to do — so a caller never has to ask first whether a section
   * is loader-backed.
   *
   * ONE PRODUCTION CALLER: the mount's idle walk, which covers the board after the first
   * frame. A load that fails is reported where the page mounts, inside the screen's error
   * boundary, where somebody is waiting for it; the walk drops its own rejection because
   * nobody is.
   */
  public async preload(section: SettingsPageId): Promise<void> {
    await this.#loadedBodiesBySection.get(section)?.load();
  }

  /**
   * Which registered sections have a page still to load, in RAIL order.
   *
   * The two boards' `unloadedKeys`, with their ordering reason read one level down: what
   * the walk warms first is observable in what a person never waits for, and registration
   * order would make it depend on which page module the chunk root evaluated first.
   * Already-resolved sections drop out, so a second walk over a warm board does nothing
   * rather than re-entering every memo.
   */
  public unloadedKeys(): readonly SettingsPageId[] {
    return SETTINGS_PAGE_IDS.filter(
      (section) => this.#loadedBodiesBySection.get(section)?.isResolved === false,
    );
  }

  public unregister(section: SettingsPageId): void {
    this.#descriptorsBySection.unregister(section);
    this.#loadedBodiesBySection.delete(section);
  }

  public descriptorFor(section: SettingsPageId): SettingsPageDescriptor | undefined {
    return this.#descriptorsBySection.get(section);
  }

  /** Which sections have a page, in rail order rather than registration order. */
  public registeredSections(): readonly SettingsPageId[] {
    return SETTINGS_PAGE_IDS.filter((section) => this.#descriptorsBySection.has(section));
  }

  /** Every registered page, in rail order. The search index's input. */
  public entries(): readonly SettingsPageDescriptor[] {
    return this.registeredSections()
      .map((section) => this.#descriptorsBySection.get(section))
      .filter((descriptor): descriptor is SettingsPageDescriptor => descriptor !== undefined);
  }
}

// There is deliberately NO module-scope page registry here. The settings screen is handed
// the one its registrar composed, for `registerFeatureContributions`' reason one level
// down: a singleton would make the pane's contents depend on a side effect of the
// screen registration, so a test rendering the screen directly would get an empty
// pane and a second settings window could not compose a different subset.

/**
 * Rank settings entries against a query.
 *
 * The scoring is `scoreSubsequence`'s and none of it is re-implemented here — the
 * only decision this function makes is WHICH strings an entry offers (its label,
 * its section label, and its aliases) and that the best of them wins. An empty
 * query answers every entry in rail order, which is what the pane shows before
 * anyone has typed.
 *
 * Ties break on rail order, because the input is already in it and `Array.sort` is
 * stable — so two equally-good hits never swap places between keystrokes.
 */
export function matchSettingsPages(
  entries: readonly SettingsPageDescriptor[],
  query: string,
): readonly SettingsPageMatch[] {
  const trimmedQuery = query.trim();
  if (trimmedQuery === "") {
    return entries.map((descriptor) => ({
      descriptor,
      matchedText: descriptor.label,
      score: 0,
    }));
  }
  const matches: SettingsPageMatch[] = [];
  for (const descriptor of entries) {
    const candidates = [
      descriptor.label,
      SETTINGS_PAGE_LABELS[descriptor.section],
      ...descriptor.keywords,
    ];
    let best: SettingsPageMatch | undefined;
    for (const candidate of candidates) {
      const scored = scoreSubsequence(candidate, trimmedQuery);
      if (scored !== undefined && (best === undefined || scored.score > best.score)) {
        best = { descriptor, matchedText: candidate, score: scored.score };
      }
    }
    if (best !== undefined) {
      matches.push(best);
    }
  }
  return matches.sort((left, right) => right.score - left.score);
}

/**
 * A registry holding every page of the table, composed for one mount of the screen.
 *
 * A fresh registry per call, so a second window composes its own set and a suite renders
 * against a registry it owns.
 */
export function composeSettingsPages(): SettingsPageRegistry {
  const registry = new SettingsPageRegistry();
  for (const page of SETTINGS_PAGES) {
    registry.register(page);
  }
  return registry;
}

/** The settings pages, in page-list order. */
export const SETTINGS_PAGES: readonly SettingsPageRegistration[] = [
  {
    section: "general",
    owner: "settings-application",
    label: "General",
    keywords: [
      "updates",
      "version",
      "restart",
      "release",
      "crash reports",
      "crash reporting",
      "about",
      "build",
    ],
    render: (context) => createElement(GeneralPage, { context }),
  },
  {
    section: "providers",
    owner: "settings-accounts",
    label: "Providers",
    keywords: [
      "provider",
      "credentials",
      "sign in",
      "login",
      "billing",
      "quota",
      "rate limit",
      "default account",
      "readiness",
    ],
    render: () => createElement(ProvidersPage),
  },
  {
    section: "mcp-servers",
    owner: "settings-mcp",
    label: "MCP servers",
    keywords: [
      "tools",
      "servers",
      "model context protocol",
      "governance",
      "trust",
      "overrides",
      "reconnect",
      "authorize",
    ],
    render: () => createElement(McpServersPage),
  },
  {
    // A loader, so the page and its sheet stay off the initial import graph: the label
    // and keywords stay here because the page list and search read them before any
    // page's chunk has loaded.
    section: "browser",
    owner: "settings-browser",
    label: "Browser",
    keywords: ["web", "site data", "cookies", "storage", "file boundary", "page tools", "clear"],
    body: () => import("./pages/browser/browser-settings-page-body.js"),
  },
  {
    section: "keyboard",
    owner: "settings-keyboard",
    label: "Keyboard",
    keywords: [
      "shortcut",
      "chord",
      "hotkey",
      "binding",
      "keys",
      "palette",
      "accelerator",
      "rebind",
    ],
    render: () => createElement(KeyboardPage),
  },
  {
    section: "appearance",
    owner: "settings-appearance",
    label: "Appearance",
    keywords: ["theme", "dark", "light", "color", "scheme", "contrast", "display"],
    render: (context) => createElement(AppearancePage, { chooseScheme: context.chooseScheme }),
  },
  {
    section: "notifications",
    owner: "settings-notifications",
    label: "Notifications",
    keywords: [
      "alerts",
      "toasts",
      "mute",
      "attention",
      "interruptions",
      "badges",
      "do not disturb",
    ],
    render: () => createElement(NotificationsPage),
  },
  {
    section: "runtime",
    owner: "settings-daemon",
    label: "Runtime",
    keywords: ["daemon", "supervisor", "runtime", "restart", "stop", "heartbeat", "connection"],
    render: (context) => createElement(RuntimePage, { context }),
  },
];

/** What every registration carries, whichever form it takes. */
interface SettingsPageRegistrationBase {
  readonly section: SettingsPageId;
  readonly owner: string;
  readonly label: string;
  readonly keywords: readonly string[];
}
