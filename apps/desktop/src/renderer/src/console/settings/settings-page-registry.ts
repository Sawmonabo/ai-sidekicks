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
// The fourteen sections are built by four lanes at once and three of them are bodies
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
import { scoreSubsequence } from "../palette/index.js";
import { Nothing } from "../primitives/index.js";
import type { SessionStore, ShellState } from "../store/index.js";
import { LoadedLazyBody, type LazyBodyLoader, type OwnerSlotProps } from "../seats/index.js";
import { PendingSettingsPageBody } from "./PendingSettingsPageBody.js";
import {
  SETTINGS_SECTION_IDS,
  SETTINGS_SECTION_LABELS,
  type SettingsSectionId,
} from "./settings-sections.js";

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
  /**
   * That session's store, where this window has it open.
   *
   * A page that reads a session-scoped wire needs a push signal or it goes stale
   * with nothing on screen saying so, and the session's own event stream is the
   * one the console already subscribes to — exactly once, in the frame's binder.
   * Handing the STORE here is what lets a page bind to that stream rather than
   * open a second `daemon.subscribe`, which would be a second copy of one feed.
   *
   * It is the retained session's store and never a store a page may open: the
   * registry resolves it, `undefined` means this window has that session closed,
   * and a page reads that as one refresh signal fewer rather than as a failure.
   */
  readonly retainedSessionStore: SessionStore | undefined;
  /**
   * What this window has been told about the shell it is running against.
   *
   * READ FROM THE WINDOW'S OWN STORE, never re-read here. The frame opens exactly one
   * subscription for it and every consumer — the frame's chip, the palette's
   * read-only line, and the local-runtime page — renders the same value, so the three
   * surfaces cannot report different supervisor states in one window.
   */
  readonly shellState: ShellState;
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

/** What every registration carries, whichever form it takes. */
interface SettingsPageRegistrationBase {
  readonly section: SettingsSectionId;
  readonly owner: string;
  readonly label: string;
  readonly keywords: readonly string[];
}

/**
 * What a page hands {@link SettingsPageRegistrar.register}, in one of exactly two forms.
 *
 * THE DECK'S AND THE FRAME'S OWN UNION, applied to a rail section, decided by the same
 * product fact and normalised by the same `LoadedLazyBody`. `seats/pane-registry.ts`
 * states the reasoning; what makes it apply here is that a settings page is not painted
 * before a person acts — settings is a destination somebody navigates to, and a section
 * inside it is a second act after that.
 *
 * IT IS NOT MERELY A SIZE QUESTION, and the case that forced this arm shows why. The
 * sidekicks page's body is the AGENTS family's, and that family's door is imported
 * EAGERLY by `collaboration-family.ts` for the agent console's surface registration. So
 * while this registry took only a `render`, the registration site had to reach the page
 * through that door, and the bundler — which assigns a module reachable both statically
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

/**
 * The one operation a registration site outside this family performs.
 *
 * Published through the family's door so a root composition file registers a page
 * without holding the registry class, the section vocabulary, or the descriptor
 * shape — which are this family's intra-family contract and stay deep. A door that
 * withheld the whole registry left `sidekicks-settings-page.ts` reaching around it,
 * which inverts the decision rather than respecting it: the registration this file
 * performs is exactly the public surface a door exists to expose.
 */
export interface SettingsPageRegistrar {
  register(registration: SettingsPageRegistration): void;
}

export class SettingsPageRegistry implements SettingsPageRegistrar {
  // `"owner-scoped"`, for `seats/surface-registry.ts`'s reason: a hot reload re-runs
  // the owning lane's module and must replace, while two lanes on one section is a
  // conflict rather than a swap decided by module import order.
  readonly #descriptorsBySection = new KeyedRegistry<SettingsSectionId, SettingsPageDescriptor>({
    duplicatePolicy: "owner-scoped",
    describeWhat: "settings section",
    ownerOf: (descriptor) => descriptor.owner,
    duplicateHint: "the settings pane renders one page per section, in rail order",
  });

  /**
   * The loader-backed pages, so {@link preload} has something to resolve.
   *
   * A second table rather than a member on the descriptor, for the two `seats/` boards'
   * reason: the descriptor is what every mount site reads and none of them has business
   * knowing whether the page it is about to render arrived as a chunk.
   */
  readonly #loadedBodiesBySection = new Map<
    SettingsSectionId,
    LoadedLazyBody<SettingsPageContext>
  >();

  /**
   * Claim a section. A second claim by a different owner is an error, not a swap.
   *
   * A loader-form registration is normalised here exactly as the deck's and the frame's
   * boards normalise theirs: one `LoadedLazyBody` per registration — one memoised promise
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
    const loadedBody = new LoadedLazyBody(registration.body, () =>
      createElement(PendingSettingsPageBody, { section: registration.section }),
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
   * The two `seats/` boards' `preload`, with its reasoning unchanged: idempotent by
   * construction, because the promise is memoised on the registration, and a
   * component-form or unregistered section settles immediately with nothing to do — so a
   * caller never has to ask first whether a section is loader-backed.
   *
   * TWO PRODUCTION CALLERS, which are the two the boards in `seats/` have. The shared
   * section-opening callback calls it before it navigates, so the rail's row and a search
   * hit warm the same page through one line — `frame/rail-navigation.ts` warms a
   * destination at that same moment and for that same reason — and an idle walk covers
   * the board before either of them reaches it.
   *
   * THE WALK IS HERE NOW, AND THE ARGUMENT AGAINST IT WAS WRONG. It ran: this registry is
   * composed per mount, so by the time it exists the destination is already open and
   * there is no earlier moment to use. The registration union above answers that in its
   * own words — "settings is a destination somebody navigates to, and a section inside it
   * is a second act after that" — so the board's lifetime begins at the FIRST act and the
   * interval before the second one is exactly the idle a warm is charged to. A board
   * holding only `render:` pages walks in one step and fetches nothing, which is what
   * makes arming it unconditional honest. `settings-page-warm.ts` binds that walk to a
   * MOUNT rather than to a window, because so is this board.
   */
  public async preload(section: SettingsSectionId): Promise<void> {
    await this.#loadedBodiesBySection.get(section)?.load();
  }

  /**
   * Which registered sections have a page still to load, in RAIL order.
   *
   * The two boards' `unloadedKeys`, with their ordering reason read one level down: what
   * the walk warms first is observable in what a person never waits for, and registration
   * order would make it depend on which page lane the chunk root evaluated first.
   * Already-resolved sections drop out, so a second walk over a warm board does nothing
   * rather than re-entering every memo.
   */
  public unloadedKeys(): readonly SettingsSectionId[] {
    return SETTINGS_SECTION_IDS.filter(
      (section) => this.#loadedBodiesBySection.get(section)?.isResolved === false,
    );
  }

  public unregister(section: SettingsSectionId): void {
    this.#descriptorsBySection.unregister(section);
    this.#loadedBodiesBySection.delete(section);
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
// contract `seats/owner-slot.ts` declares — who owns the body, what the
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
// contract is developer-facing (`seats/owner-slot.ts` says so in terms),
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
