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
import { LoaderBackedBody, type LazyBodyLoader } from "@renderer/components/LazyBody/lazy-body.js";
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
 * One entry of the page table, in one of exactly two forms: an eager `render`, or a `body`
 * loader.
 *
 * The same union as the pane layout's and the frame's (see `registries/panes/pane-registry.ts`),
 * normalized by the same `LoaderBackedBody`. A settings page is not painted before a person
 * acts, so a loader keeps its page and stylesheet off the initial import graph: a module
 * reachable both statically and dynamically lands in the static chunk, and a loader lets the
 * registration name a chunk root instead of a component.
 *
 * A union rather than two optional members, since `render?` beside `body?` would make "both"
 * and "neither" representable, and a registry cannot know which the page meant.
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
 * A second claim on a section throws rather than replacing it.
 */
export class SettingsPageRegistry {
  readonly #descriptorsBySection = new KeyedRegistry<SettingsPageId, SettingsPageDescriptor>({
    duplicatePolicy: "throw",
    describeWhat: "settings section",
    duplicateHint: "the settings pane renders one page per section, in rail order",
  });

  /**
   * The loader-backed pages, so {@link preload} has something to resolve.
   *
   * Kept apart from the descriptor because every mount site reads the descriptor and none
   * needs to know whether the page arrived as a chunk.
   */
  readonly #loadedBodiesBySection = new Map<
    SettingsPageId,
    LoaderBackedBody<SettingsPageContext>
  >();

  /**
   * Claim a section. A second claim on it is an error, not a swap.
   *
   * A loader-form registration becomes one `LoaderBackedBody` (one memoized promise, one
   * stable lazy component) and a descriptor whose `render` mounts it, so `descriptorFor` and
   * `entries` answer the same shape for both forms and neither `SettingsPane` nor the search
   * index branches on how a body arrived. The descriptor is registered first so a refusal (a
   * second claim on a taken section) throws before the loader table is touched and cannot
   * strip the loader off the registration that survives it.
   */
  public register(registration: SettingsPageRegistration): void {
    const descriptorBase = {
      section: registration.section,
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
    // The fallback is the page region's own reservation, supplied here because what a
    // settings page reserves while it loads is settings-shaped, and the pane above has
    // already drawn the heading.
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
   * Idempotent, because the promise is memoized on the registration; a component-form or
   * unregistered section settles immediately. The one production caller is the idle walk
   * (`hooks/useSettingsPageIdleWarm.ts`) after the first frame. A load that fails is
   * reported where the page mounts, inside the screen's error boundary; the walk drops its
   * own rejection because nobody is waiting on it.
   */
  public async preload(section: SettingsPageId): Promise<void> {
    await this.#loadedBodiesBySection.get(section)?.load();
  }

  /**
   * Which registered sections have a page still to load, in rail order.
   *
   * Rail order, not registration order, so what the idle walk warms first does not depend on
   * which page module evaluated first. Resolved sections drop out, so a second walk over a
   * warm board does nothing.
   */
  public unloadedKeys(): readonly SettingsPageId[] {
    return SETTINGS_PAGE_IDS.filter(
      (section) => this.#loadedBodiesBySection.get(section)?.isResolved === false,
    );
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

// There is no module-scope registry of page descriptors: the screen is handed the one its
// registrar composed, so a test rendering the screen directly composes its own set and a second
// settings window could compose a different subset. A page's body is the exception, held at
// module scope in `pages/page-body-registry.ts` as the composer is in the composer registry: a
// composition fills it before any screen mounts, and the page that draws it imports no body.

/**
 * Rank settings entries against a query.
 *
 * The scoring is `scoreSubsequence`'s; this function only decides which strings an entry
 * offers (its label, its section label and its aliases) and that the best of them wins. An
 * empty query answers every entry in rail order. Ties break on rail order, since the input is
 * in it and `Array.sort` is stable, so equally good hits never swap places between
 * keystrokes.
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
    label: "General",
    keywords: ["version", "about", "build"],
    render: (context) => createElement(GeneralPage, { context }),
  },
  {
    section: "providers",
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
    label: "MCP servers",
    keywords: [
      "tools",
      "servers",
      "model context protocol",
      "governance",
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
    label: "Browser",
    keywords: ["web", "site data", "cookies", "storage", "file boundary", "page tools", "clear"],
    body: () => import("./pages/browser/browser-settings-page-body.js"),
  },
  {
    section: "keyboard",
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
    label: "Appearance",
    keywords: ["theme", "dark", "light", "color", "scheme", "contrast", "display"],
    render: (context) => createElement(AppearancePage, { chooseScheme: context.chooseScheme }),
  },
  {
    section: "notifications",
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
    label: "Runtime",
    keywords: ["background service", "runtime", "restart", "stop", "connection"],
    render: (context) => createElement(RuntimePage, { context }),
  },
];

/** What every registration carries, whichever form it takes. */
interface SettingsPageRegistrationBase {
  readonly section: SettingsPageId;
  readonly label: string;
  readonly keywords: readonly string[];
}
