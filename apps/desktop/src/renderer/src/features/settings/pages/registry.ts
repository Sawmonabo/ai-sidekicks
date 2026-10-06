// The settings page table: each page's heading, note, findable words and controls, and how its
// body arrives.
//
// The screen is a page list and a pane holding the open page. `SETTINGS_PAGES` is the table;
// `SettingsPageRegistry` is what one mount of the screen composes from it, so no window inherits
// another's pages. What search does with the words each page declares is `../search.ts`.

import { createElement, type ReactNode } from "react";

import { KeyedRegistry } from "#renderer/lib/keyed-registry.js";
import { LoaderBackedBody, type LazyBodyLoader } from "#renderer/components/LazyBody/loader.js";
import { AppearancePage } from "./appearance/AppearancePage.js";
import { APPEARANCE_CONTROLS } from "./appearance/controls.js";
import { findSettingsPageBody } from "./body-registry.js";
import { GENERAL_CONTROLS } from "./general/controls.js";
import { GeneralPage } from "./general/GeneralPage.js";
import { KEYBOARD_CONTROLS } from "./keyboard/controls.js";
import { KeyboardPage } from "./keyboard/KeyboardPage.js";
import { McpServersPage } from "./mcp-servers/McpServersPage.js";
import { NotificationsPage } from "./notifications/NotificationsPage.js";
import { ProvidersPage } from "./providers/ProvidersPage.js";
import { RUNTIME_CONTROLS } from "./runtime/controls.js";
import { RuntimePage } from "./runtime/RuntimePage.js";
import type { SettingsControl, SettingsPageBody, SettingsPageContext } from "../types.js";
import { SETTINGS_PAGE_IDS, type SettingsPageId } from "#renderer/routing/settings-page-ids.js";

/** One registered page, as the page list, the pane and search read it. */
export interface SettingsPageDescriptor {
  readonly pageId: SettingsPageId;
  /** The page's own heading. The page list shows `SETTINGS_PAGE_LABELS`. */
  readonly label: string;
  /**
   * Other words a person may type for this page.
   *
   * Search finds the page on its heading, its list label or any of these, so "shortcut" finds
   * the Keyboard page.
   */
  readonly keywords: readonly string[];
  /** The one line under the heading saying what the page is and where its values are kept. */
  readonly note: string;
  /** The controls search finds on this page, in the order the page draws them. */
  readonly controls: readonly SettingsControl[];
  readonly render: SettingsPageBody;
}

/**
 * One entry of the page table, in one of exactly two forms: an eager `render`, or a `body`
 * loader.
 *
 * The same union as the pane layout's and the frame's (see `registries/panes/registry.ts`),
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

/**
 * The pages one mount of the Settings screen holds, keyed by page.
 *
 * A second claim on a page throws rather than replacing it.
 */
export class SettingsPageRegistry {
  readonly #descriptorsByPageId = new KeyedRegistry<SettingsPageId, SettingsPageDescriptor>({
    duplicatePolicy: "throw",
    describeWhat: "settings page",
    duplicateHint: "the settings pane renders one body per page, in page-list order",
  });

  /**
   * The loader-backed pages, so {@link preload} has something to resolve.
   *
   * Kept apart from the descriptor because every mount site reads the descriptor and none
   * needs to know whether the page arrived as a chunk.
   */
  readonly #loadedBodiesByPageId = new Map<SettingsPageId, LoaderBackedBody<SettingsPageContext>>();

  /**
   * Claim a page. A second claim on it is an error, not a swap.
   *
   * A loader-form registration becomes one `LoaderBackedBody` (one memoized promise, one
   * stable lazy component) and a descriptor whose `render` mounts it, so `descriptorFor` and
   * `entries` answer the same shape for both forms and neither `SettingsPane` nor search
   * branches on how a body arrived. The descriptor is registered first so a refusal (a
   * second claim on a taken page) throws before the loader table is touched and cannot
   * strip the loader off the registration that survives it.
   */
  public register(registration: SettingsPageRegistration): void {
    const descriptorBase = {
      pageId: registration.pageId,
      label: registration.label,
      keywords: registration.keywords,
      note: registration.note,
      controls: registration.controls ?? [],
    };
    if (registration.body === undefined) {
      this.#descriptorsByPageId.register(registration.pageId, {
        ...descriptorBase,
        render: registration.render,
      });
      this.#loadedBodiesByPageId.delete(registration.pageId);
      return;
    }
    // Nothing draws while the page loads: the pane above has already drawn the frame and
    // heading, and the page has asked the daemon for nothing, so no empty state fits.
    const loadedBody = new LoaderBackedBody(registration.body, () => null);
    this.#descriptorsByPageId.register(registration.pageId, {
      ...descriptorBase,
      render: loadedBody.render,
    });
    this.#loadedBodiesByPageId.set(registration.pageId, loadedBody);
  }

  /**
   * Start this page's body loading, without opening it.
   *
   * Idempotent, because the promise is memoized on the registration; a component-form or
   * unregistered page settles immediately. The one production caller is the idle walk
   * (`hooks/useSettingsPageIdleWarm.ts`) after the first frame. A load that fails is
   * reported where the page mounts, inside the screen's error boundary; the walk drops its
   * own rejection because nobody is waiting on it.
   */
  public async preload(pageId: SettingsPageId): Promise<void> {
    await this.#loadedBodiesByPageId.get(pageId)?.load();
  }

  /**
   * Which registered pages have a body still to load, in page-list order.
   *
   * Page-list order, not registration order, so what the idle walk warms first does not depend
   * on which page module evaluated first. Resolved pages drop out, so a second walk over a
   * warm board does nothing.
   */
  public unloadedKeys(): readonly SettingsPageId[] {
    return SETTINGS_PAGE_IDS.filter(
      (pageId) => this.#loadedBodiesByPageId.get(pageId)?.isResolved === false,
    );
  }

  public descriptorFor(pageId: SettingsPageId): SettingsPageDescriptor | undefined {
    return this.#descriptorsByPageId.get(pageId);
  }

  /** Which pages are registered, in page-list order rather than registration order. */
  public registeredPageIds(): readonly SettingsPageId[] {
    return SETTINGS_PAGE_IDS.filter((pageId) => this.#descriptorsByPageId.has(pageId));
  }

  /** Every registered page, in page-list order. Search's input. */
  public entries(): readonly SettingsPageDescriptor[] {
    return this.registeredPageIds()
      .map((pageId) => this.#descriptorsByPageId.get(pageId))
      .filter((descriptor): descriptor is SettingsPageDescriptor => descriptor !== undefined);
  }
}

// There is no module-scope registry of page descriptors: the screen is handed the one its
// registrar composed, so a test rendering the screen directly composes its own set and a second
// settings window could compose a different subset. A page's body is the exception, held at
// module scope in `pages/body-registry.ts` as the composer is in the composer registry: a
// composition fills it before any screen mounts, and the page that draws it imports no body.

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
    pageId: "general",
    label: "General",
    keywords: ["version", "about", "build"],
    note: "What this install is, how it updates itself, and what a new session starts from.",
    controls: GENERAL_CONTROLS,
    render: (context) => createElement(GeneralPage, { context }),
  },
  {
    pageId: "providers",
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
    note:
      "Sign in to Claude Code and Codex, choose which account new work runs on, and set what " +
      "each provider does on its own. Every sign-in and pasted token stays on this machine.",
    render: () => createElement(ProvidersPage),
  },
  {
    pageId: "mcp-servers",
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
    note:
      "The tool servers Claude Code and Codex connect to, and what each is allowed to do. " +
      "Read live from the background service.",
    render: () => createElement(McpServersPage),
  },
  {
    pageId: "projects",
    label: "Projects",
    keywords: ["repositories", "clone", "worktree", "environment variables", "branch names"],
    note:
      "Where cloned repositories go, every project attached to this machine, what happens " +
      "after a worktree is made, and the environment rows every process starts with.",
    // The frame draws the heading and the note; this page draws nothing under them.
    render: () => null,
  },
  {
    // A loader, so the page and its sheet stay off the initial import graph: the label
    // and keywords stay here because the page list and search read them before any
    // page's chunk has loaded.
    pageId: "browser",
    label: "Browser",
    keywords: ["web", "site data", "cookies", "storage", "file boundary", "page tools", "clear"],
    note:
      "What the browser inside the app remembers, and whether sidekicks can drive it. One set " +
      "of site data for this machine.",
    body: () => import("./browser/body.js"),
  },
  {
    pageId: "keyboard",
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
    note: "Every key the app answers to. Change any of them.",
    controls: KEYBOARD_CONTROLS,
    render: () => createElement(KeyboardPage),
  },
  {
    pageId: "appearance",
    label: "Appearance",
    keywords: ["theme", "dark", "light", "color", "scheme", "contrast", "display"],
    note: "How the app looks.",
    controls: APPEARANCE_CONTROLS,
    render: (context) => createElement(AppearancePage, { chooseScheme: context.chooseScheme }),
  },
  {
    pageId: "notifications",
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
    note: "When the app tells you something is waiting.",
    render: () => createElement(NotificationsPage),
  },
  {
    pageId: "runtime",
    label: "Runtime",
    keywords: ["background service", "runtime", "restart", "stop", "connection"],
    note:
      "The background service that runs sidekicks, the folders it can reach, what it keeps, " +
      "and the port it listens on.",
    controls: RUNTIME_CONTROLS,
    render: (context) => createElement(RuntimePage, { context }),
  },
  {
    // The Remote Control feature fills this body through the page body registry.
    pageId: "devices",
    label: "Devices",
    keywords: ["remote control", "phone", "link a device", "passkeys", "shared ports"],
    note: "Computers and devices linked to reach sessions remotely.",
    render: () => renderRegisteredBody("devices"),
  },
];

/** What every registration carries, whichever form it takes. */
interface SettingsPageRegistrationBase {
  readonly pageId: SettingsPageId;
  readonly label: string;
  readonly keywords: readonly string[];
  readonly note: string;
  /** Absent for a page that declares no findable controls. */
  readonly controls?: readonly SettingsControl[];
}

/** The body a composition registered for a page, or nothing while none is registered. */
function renderRegisteredBody(pageId: SettingsPageId): ReactNode {
  const RegisteredBody = findSettingsPageBody(pageId);
  return RegisteredBody === undefined ? null : createElement(RegisteredBody);
}
