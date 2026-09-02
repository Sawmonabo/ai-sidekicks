// The settings entry index: which page holds which section, and how a term finds it.
//
// `Spec-023 §Console Design (Meridian)` §The settings surface fixes the shape: "A
// left rail of sections and a right pane holding the selected one … Every registry
// entry declares an id, a section, a label, keyword aliases, and its renderer, so a
// match names where it landed, scrolls into the pane, and settles with one brief
// highlight."
//
// WHY A REGISTRY RATHER THAN A SWITCH
//
// The thirteen sections are built by four lanes at once and three of them are bodies
// this repository does not author at all. A `switch` over section ids would be one
// file every lane edits — the conflict the console's seat boards exist to avoid,
// one level down. A page claims its section through {@link registerSettingsPage}
// and the surface resolves the current section against the table.
//
// WHY THE MATCHER IS BORROWED AND NOT WRITTEN
//
// "One matcher, `matchSettingsEntries`, is shared with the palette so a term ranks
// identically in both places." `palette/subsequence-score.ts` IS that matcher, and
// its own family door says in terms that settings search reaches for it directly
// rather than through the palette barrel. What lives here is the ENTRY INDEX — what
// text a settings entry offers the scorer — and nothing about scoring itself.

import { createElement, type ReactNode } from "react";

import { KeyedRegistry } from "../core/index.js";
import { type ConsoleBridge } from "../bridge/index.js";
import { scoreSubsequence } from "../palette/subsequence-score.js";
import { Nothing } from "../primitives/index.js";
import type { OwnerSlotProps } from "../workspace/index.js";

/**
 * Every settings section, in rail order.
 *
 * The twelve the design enumerates, in its order, plus `sidekicks`. The rail a
 * person reads is this tuple, and the union is derived from it for the reason
 * `frame/surface-registry.ts` gives about its own slots: a union written beside a
 * hand-repeated array is two closed sets that agree until one of them is widened.
 *
 * `sidekicks` is the one id that is this console's own rather than the design's.
 * The design puts the saved-sidekick page IN settings and reaches it from the
 * in-session attach picker, but its section enumeration names no id for it, so a
 * page that exists and a rail that cannot reach it was the alternative. An id
 * carries no wire and asserts nothing about the daemon, which is why it can be
 * decided here; a PAGE with no body still could not be, and this one has one.
 */
export const SETTINGS_SECTION_IDS = [
  "accounts",
  "mcp-servers",
  "sidekicks",
  "cost",
  "nodes",
  "notifications",
  "keyboard",
  "appearance",
  "mounts",
  "diagnostics",
  "data",
  "application",
  "browser",
] as const;

/** One settings section. Derived from the enumeration, never restated. */
export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number];

/**
 * The rail's label for each section, in one place.
 *
 * A TOTAL record, so a fourteenth section is a compile error here until its label
 * is decided — the label cannot silently default to the id, which is how a rail
 * grows an entry reading `mcp-servers`.
 */
export const SETTINGS_SECTION_LABELS: Readonly<Record<SettingsSectionId, string>> = {
  accounts: "Accounts",
  "mcp-servers": "MCP servers",
  sidekicks: "Sidekicks",
  cost: "Cost",
  nodes: "Nodes",
  notifications: "Notifications",
  keyboard: "Keyboard",
  appearance: "Appearance",
  mounts: "Mounts",
  diagnostics: "Diagnostics",
  data: "Data",
  application: "Application",
  browser: "Browser",
};

/**
 * Everything a settings page is handed.
 *
 * Deliberately narrower than `ConsoleSurfaceContext`: a page reads its own wire and
 * navigates the rail, and handing it the session stores would invite a page to hold
 * session state the settings surface has no session for.
 */
export interface SettingsPageContext {
  readonly bridge: ConsoleBridge;
  /** Renderer-local rail navigation — the deep-link grammar's other half. */
  readonly openSection: (section: SettingsSectionId) => void;
  /**
   * The session this window most recently opened, or `undefined` where it has
   * opened none.
   *
   * The frame store's RETAINED id and deliberately not its route projection. Every
   * settings address is `kind: "settings"` and names no session, so the projection
   * is `undefined` on every one of them — a session-scoped page handed it would
   * render its no-session arm forever, which is a constant wearing an absence's
   * clothes rather than a reading. The retained id is the fact that answers the
   * question these pages are actually asking: which session this window is working
   * in, whether or not the address it is parked on says so.
   *
   * `undefined` stays a real answer: a window that has opened no session hands the
   * pages nothing, and a page that ASKED and was told nothing renders an honest
   * absence. It is deliberately NOT the session STORE: a settings page that could
   * reach the projection could hold session state, and the settings surface has no
   * session to hold it for.
   */
  readonly retainedSessionId: string | undefined;
}

/** What a page renders. A function rather than a component type, as the seats are. */
export type SettingsPageBody = (context: SettingsPageContext) => ReactNode;

export interface SettingsPageDescriptor {
  readonly section: SettingsSectionId;
  /** The lane that owns it, so an unfilled section names someone. */
  readonly owner: string;
  /** The page's own heading. The rail shows {@link SETTINGS_SECTION_LABELS}. */
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

export class SettingsPageRegistry {
  // `"owner-scoped"`, for `frame/surface-registry.ts`'s reason: a hot reload re-runs
  // the owning lane's module and must replace, while two lanes on one section is a
  // conflict rather than a swap decided by module import order.
  readonly #descriptorsBySection = new KeyedRegistry<SettingsSectionId, SettingsPageDescriptor>({
    duplicatePolicy: "owner-scoped",
    describeWhat: "settings section",
    ownerOf: (descriptor) => descriptor.owner,
    duplicateHint: "the settings pane renders one page per section, in rail order",
  });

  /** Claim a section. A second claim by a different owner is an error, not a swap. */
  public register(descriptor: SettingsPageDescriptor): void {
    this.#descriptorsBySection.register(descriptor.section, descriptor);
  }

  public unregister(section: SettingsSectionId): void {
    this.#descriptorsBySection.unregister(section);
  }

  public descriptorFor(section: SettingsSectionId): SettingsPageDescriptor | undefined {
    return this.#descriptorsBySection.get(section);
  }

  /** Which sections have a page, in rail order rather than registration order. */
  public registeredSections(): readonly SettingsSectionId[] {
    return SETTINGS_SECTION_IDS.filter((section) => this.#descriptorsBySection.has(section));
  }

  /** Every registered page, in rail order. The search index's input. */
  public entries(): readonly SettingsPageDescriptor[] {
    return this.registeredSections()
      .map((section) => this.#descriptorsBySection.get(section))
      .filter((descriptor): descriptor is SettingsPageDescriptor => descriptor !== undefined);
  }
}

// There is deliberately NO module-scope page registry here. The surface is handed
// the one its registrar composed, for `registerConsoleFamilies`' reason one level
// down: a singleton would make the pane's contents depend on a side effect of the
// slot registration, so a test rendering the surface directly would get an empty
// pane and a second settings window could not compose a different subset.

/** One ranked search hit: the entry, the text that matched, and its score. */
export interface SettingsEntryMatch {
  readonly descriptor: SettingsPageDescriptor;
  /** The label or alias the score was earned on, so the result can say why. */
  readonly matchedText: string;
  readonly score: number;
}

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
export function matchSettingsEntries(
  entries: readonly SettingsPageDescriptor[],
  query: string,
): readonly SettingsEntryMatch[] {
  const trimmedQuery = query.trim();
  if (trimmedQuery === "") {
    return entries.map((descriptor) => ({
      descriptor,
      matchedText: descriptor.label,
      score: 0,
    }));
  }
  const matches: SettingsEntryMatch[] = [];
  for (const descriptor of entries) {
    const candidates = [
      descriptor.label,
      SETTINGS_SECTION_LABELS[descriptor.section],
      ...descriptor.keywords,
    ];
    let best: SettingsEntryMatch | undefined;
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

// --- Pages whose body another plan authors ---------------------------------
//
// Two settings sections are holes another plan fills: the provider-account
// registry and the MCP server inventory. Each is a PAGE this repository builds the
// chrome for and a BODY it does not author at all, so the arrangement is the seat
// contract `workspace/seats/owner-slot.ts` declares — who owns the body, what the
// mount owes it, and where the shell dies.
//
// WHY THE RENDERER IS HERE AND THE SLOTS ARE NOT
//
// Each slot lives beside the page that mounts it, because the reservation copy, the
// body's props, and the section registration are one decision. What is shared is
// the four lines that CHOOSE between a body and its reservation, and those were
// written twice before this function existed — `apps/desktop/AGENTS.md` hoists on
// the second use, and this module is the lowest one both pages already import.
//
// The reservation copy names the FEATURE and never the governance work — a slot
// contract is developer-facing (`workspace/seats/owner-slot.ts` says so in terms),
// and the repository's standing rule keeps governance identifiers out of what a
// participant reads.

/** One page whose body another plan authors: the seat, and what it says today. */
export interface OwnerSlotPage {
  readonly slot: OwnerSlotProps<SettingsPageBody>;
  /** What is absent, in one sentence. The feature, never the work that owes it. */
  readonly reservationTitle: string;
  /** The second line: what the body will hold, and what has not been asked for. */
  readonly reservationDetail: string;
}

/**
 * Render one such page: the body if it has arrived, the reservation if not.
 *
 * "Reserved, not stubbed" — the console says the body has not been built rather
 * than drawing an empty pane that reads as a broken feature. The absence is a
 * `surface` placement because it stands in for the region the body would fill, not
 * for one value inside it.
 */
export function renderOwnerSlotPage(page: OwnerSlotPage, context: SettingsPageContext): ReactNode {
  const { body } = page.slot;
  if (body !== undefined) {
    return body(context);
  }
  return createElement(Nothing, {
    kind: "empty",
    placement: "surface",
    title: page.reservationTitle,
    detail: page.reservationDetail,
  });
}
