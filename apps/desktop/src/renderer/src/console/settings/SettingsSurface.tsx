// The settings surface: a rail of sections, a pane holding one, and a search that
// reaches both.
//
// `Spec-023 §Console Design (Meridian)` §The settings surface: "A left rail of
// sections and a right pane holding the selected one, the split
// `Spec-023 §Renderer Responsibilities` assigns to the renderer. … A search field
// above the rail."
//
// THREE RULES THIS FILE IS THE ENFORCEMENT OF
//
//   • **No entry is hidden because its wire is unavailable.** The rail is the
//     closed section tuple, always all thirteen. A section whose page has not landed
//     renders its own reservation in the PANE; a section whose page landed and
//     whose wire refused renders that refusal in the pane. Neither ever costs a
//     rail entry, because a rail that shrinks when a daemon is unreachable is a
//     rail that teaches a person the setting does not exist.
//   • **The rail never blocks on a section read.** Nothing here awaits anything.
//     The rail is rendered from a closed tuple and the pane's read is the page's.
//   • **No second copy of a value a wire read owns.** The only state this surface
//     holds is the search query, which is a person's keystrokes and not a wire
//     value. Which section is open lives in the ROUTE, so a deep link and a rail
//     click are the same act and the back button works.
//
// The pane's own resolution happens during render, for `frame/RouteSurface.tsx`'s
// reason: the registry is composed at module scope, so a page is there to be looked
// up on the first pass, and resolving in an effect would mean the first paint has
// already said the page is missing.

import { useMemo, useState } from "react";

import { Glyph, Nothing } from "../primitives/index.js";
import type { ConsoleSurfaceContext } from "../frame/surface-registry.js";
import {
  SETTINGS_SECTION_IDS,
  SETTINGS_SECTION_LABELS,
  matchSettingsEntries,
  type SettingsEntryMatch,
  type SettingsPageContext,
  type SettingsPageRegistry,
  type SettingsSectionId,
} from "./settings-page-registry.js";

/** The search glyph sits inside the field, at the field's own optical size. */
const SEARCH_GLYPH_SIZE = 14;

export interface SettingsSurfaceProps {
  readonly context: ConsoleSurfaceContext;
  /**
   * The pages this pane may render.
   *
   * A prop rather than a module-scope singleton: the registrar composes it, so a
   * test renders against a registry it owns and a second window could render a
   * subset without a second code path.
   */
  readonly pages: SettingsPageRegistry;
}

/** The section a `#/settings/<page>` address names, or `undefined` for none of them. */
function requestedSection(page: string | undefined): SettingsSectionId | undefined {
  return SETTINGS_SECTION_IDS.find((section) => section === page);
}

export function SettingsSurface(props: SettingsSurfaceProps): React.JSX.Element {
  const { context } = props;
  const { route } = context;
  const requestedPage = route.kind === "settings" ? route.page : undefined;
  const selectedSection = requestedSection(requestedPage);
  const [searchQuery, setSearchQuery] = useState("");

  const openSection = (section: SettingsSectionId): void => {
    context.frameStore.navigate({ kind: "settings", page: section });
  };

  // The session comes off the frame store, which projects it from the route rather
  // than recording it a second time. On a `#/settings` address there is none, and a
  // session-scoped page renders that as an absence it ASKED for.
  const pageContext: SettingsPageContext = {
    bridge: context.bridge,
    openSection,
    activeSessionId: context.frameStore.activeSessionId,
  };

  // Memoised on the registry and the query: the registry is composed once by the
  // registrar and does not change while a window is open, so re-ranking on every
  // unrelated render would be work with no input change to justify it.
  const { pages } = props;
  const matches = useMemo(
    () => matchSettingsEntries(pages.entries(), searchQuery),
    [pages, searchQuery],
  );
  const isSearching = searchQuery.trim() !== "";

  return (
    <section className="meridian-settings" aria-label="Settings">
      <div className="meridian-settings__rail">
        <SettingsSearchField query={searchQuery} onQueryChange={setSearchQuery} />
        {isSearching ? (
          <SettingsSearchResults
            query={searchQuery}
            matches={matches}
            selectedSection={selectedSection}
            onOpenSection={openSection}
          />
        ) : (
          <SettingsSectionRail selectedSection={selectedSection} onOpenSection={openSection} />
        )}
      </div>
      <div className="meridian-settings__pane">
        <SettingsPane
          section={selectedSection}
          attempted={requestedPage}
          context={pageContext}
          pages={pages}
        />
      </div>
    </section>
  );
}

interface SettingsSearchFieldProps {
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
}

/**
 * The one control above the rail.
 *
 * A plain `<input type="search">` with a visible label association rather than a
 * combobox: the results below are a navigable list of links, not an autocomplete
 * popover, and announcing them as one would promise a keyboard grammar this surface
 * does not implement.
 */
function SettingsSearchField(props: SettingsSearchFieldProps): React.JSX.Element {
  return (
    <div className="meridian-settings__search">
      <Glyph name="search" size={SEARCH_GLYPH_SIZE} />
      <input
        type="search"
        className="meridian-settings__search-input"
        value={props.query}
        placeholder="Search settings"
        aria-label="Search settings"
        onChange={(changeEvent) => {
          props.onQueryChange(changeEvent.target.value);
        }}
      />
    </div>
  );
}

interface SettingsSectionRailProps {
  readonly selectedSection: SettingsSectionId | undefined;
  readonly onOpenSection: (section: SettingsSectionId) => void;
}

/** Every section, always. The rail is the closed tuple and never a filtered view of it. */
function SettingsSectionRail(props: SettingsSectionRailProps): React.JSX.Element {
  return (
    <nav aria-label="Settings sections">
      <ul className="meridian-settings__sections">
        {SETTINGS_SECTION_IDS.map((section) => (
          <li key={section}>
            <button
              type="button"
              className="meridian-settings__section"
              aria-current={section === props.selectedSection ? "page" : undefined}
              onClick={() => {
                props.onOpenSection(section);
              }}
            >
              {SETTINGS_SECTION_LABELS[section]}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

interface SettingsSearchResultsProps {
  readonly query: string;
  readonly matches: readonly SettingsEntryMatch[];
  readonly selectedSection: SettingsSectionId | undefined;
  readonly onOpenSection: (section: SettingsSectionId) => void;
}

/**
 * Ranked hits, each naming the section it landed in.
 *
 * A miss names the query and what was searched, which is the difference between "no
 * such setting" and "this console has not built that page yet" — and only the
 * second is true here, so the copy says the second.
 */
function SettingsSearchResults(props: SettingsSearchResultsProps): React.JSX.Element {
  if (props.matches.length === 0) {
    return (
      <Nothing
        kind="empty"
        placement="surface"
        title={`Nothing in settings matches “${props.query}”.`}
        detail="Every section was searched by its name, its page heading, and its aliases. A section whose page has not been built here yet carries no searchable text."
      />
    );
  }
  return (
    <nav aria-label="Settings search results">
      <ul className="meridian-settings__sections">
        {props.matches.map((match) => (
          <li key={match.descriptor.section}>
            <button
              type="button"
              className="meridian-settings__section meridian-settings__section--result"
              aria-current={match.descriptor.section === props.selectedSection ? "page" : undefined}
              onClick={() => {
                props.onOpenSection(match.descriptor.section);
              }}
            >
              <span className="meridian-settings__result-label">{match.descriptor.label}</span>
              <span className="meridian-settings__result-section">
                {SETTINGS_SECTION_LABELS[match.descriptor.section]}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

interface SettingsPaneProps {
  readonly section: SettingsSectionId | undefined;
  /** The address's own page segment, so an unknown one can be named back. */
  readonly attempted: string | undefined;
  readonly context: SettingsPageContext;
  readonly pages: SettingsPageRegistry;
}

/**
 * The right-hand pane: the selected section's page, or the reason there is none.
 *
 * Three distinct absences, kept apart because the next move differs:
 *
 *   • no section chosen — the address is `#/settings` with no page, so the pane
 *     invites a choice rather than picking one, which would make the rail's
 *     selection depend on tuple order.
 *   • a section the address named that does not exist — an error, named back.
 *   • a section with no page registered — reserved, not stubbed.
 */
function SettingsPane(props: SettingsPaneProps): React.JSX.Element {
  if (props.section === undefined) {
    if (props.attempted !== undefined) {
      return (
        <Nothing
          kind="error"
          placement="surface"
          title="That settings address does not name a section."
          detail={`Nothing in settings is called “${props.attempted}”. The rail on the left lists every section this console has.`}
        />
      );
    }
    return (
      <Nothing
        kind="empty"
        placement="surface"
        title="Choose a section."
        detail="Settings are grouped by what they govern. Search above to jump straight to one."
      />
    );
  }

  const descriptor = props.pages.descriptorFor(props.section);
  const label = SETTINGS_SECTION_LABELS[props.section];
  return (
    <article className="meridian-settings__page" aria-label={label}>
      <h2 className="meridian-settings__page-heading">{descriptor?.label ?? label}</h2>
      <div className="meridian-settings__page-body">
        {descriptor === undefined ? (
          <Nothing
            kind="empty"
            placement="surface"
            title={`The ${label.toLowerCase()} page has not been built yet.`}
            detail="It is reserved rather than missing — the section exists and its page is still being built. Nothing was asked of the daemon for it."
          />
        ) : (
          descriptor.render(props.context)
        )}
      </div>
    </article>
  );
}
