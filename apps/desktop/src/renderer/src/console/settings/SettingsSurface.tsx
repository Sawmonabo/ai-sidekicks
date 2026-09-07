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
//     closed section tuple, always all fourteen. A section whose page has not landed
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
import { useFrameStore, useOpenSessionStore, useShellState } from "../store/index.js";
import type { ConsoleSurfaceContext } from "../seats/index.js";
import {
  matchSettingsEntries,
  type SettingsPageContext,
  type SettingsPageRegistry,
} from "./settings-page-registry.js";
import { SETTINGS_SECTION_IDS, type SettingsSectionId } from "./settings-sections.js";
import { useSettingsPageIdleWarm } from "./settings-page-warm.js";
import { SettingsSearchField } from "./SettingsSearchField.js";
import { SettingsSectionRail } from "./SettingsSectionRail.js";
import { SettingsSearchResults } from "./SettingsSearchResults.js";
import { SettingsPane } from "./SettingsPane.js";

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
  const { context, pages } = props;
  const { route } = context;
  const requestedPage = route.kind === "settings" ? route.page : undefined;
  const selectedSection = requestedSection(requestedPage);
  const [searchQuery, setSearchQuery] = useState("");
  // SUBSCRIBED, not snapshotted. A getter read during render answers whatever the
  // store held on that pass and nothing re-renders when it changes, so a session
  // opened in another destination would reach these pages only on the next
  // unrelated render. The frame's own readers subscribe through this hook and so
  // does this one, which is also why the settings family holds no copy of the id.
  const retainedSessionId = useFrameStore(context.frameStore, (state) => state.lastOpenedSessionId);

  const openSection = (section: SettingsSectionId): void => {
    // WARMED BEFORE THE ROUTE COMMITS, which is `frame/rail-navigation.ts`'s rule one
    // level down: this is the moment the intent is legible and the act has not happened.
    // It sits in the SHARED callback rather than beside either control, because the rail's
    // row, a search hit, and a page that navigates to a sibling section all reach a section
    // through this one line — so none of them can be the path that forgot, and a person who
    // clicks a deferred page cold does not watch its reservation after an explicit act.
    //
    // A `render:`-form or unregistered section settles immediately with nothing done, so
    // the line asks no question about how the page it is opening was registered.
    //
    // Fire-and-forget with the rejection dropped, on the idle walk's own reasoning: a chunk
    // that will not load is a damaged install, and the honest place to say so is the mount,
    // inside the surface error boundary, where somebody is waiting for it. Awaiting here
    // would stall a navigation the person has already made.
    void pages.preload(section).catch(() => undefined);
    context.frameStore.navigate({ kind: "settings", page: section });
  };

  // The RETAINED session, never the route's projection. Every settings address is
  // `kind: "settings"` and names no session, so the projection is `undefined` on all
  // of them, and a session-scoped page handed it would render its no-session arm in
  // every window that had ever opened one. A window that has opened none still hands
  // `undefined`, and a page renders that as an absence it ASKED for.
  // The retained session's store, resolved here rather than by any page: a page
  // that could open one would open sessions from a render pass. `undefined` where
  // this window has that session closed, which a session-scoped page renders as one
  // push signal fewer and never as a failure.
  const retainedSessionStore = useOpenSessionStore(context.sessionStoreRegistry, retainedSessionId);

  // The window's shell condition, read from the store the frame keeps live. One
  // subscription per window, and this is a reader of it rather than a second one.
  const shellState = useShellState(context.frameStore);

  const pageContext: SettingsPageContext = {
    bridge: context.bridge,
    openSection,
    retainedSessionId,
    retainedSessionStore,
    shellState,
  };

  // Warmed at idle, before any of that: the board's lifetime begins when this destination
  // opens and a section is a second act after it, so the interval a person spends reading
  // the rail is the one a deferred page's chunk is charged to. A board holding only
  // `render:` pages walks in one step and fetches nothing.
  useSettingsPageIdleWarm(pages);

  // Memoised on the registry and the query: the registry is composed once by the
  // registrar and does not change while a window is open, so re-ranking on every
  // unrelated render would be work with no input change to justify it.
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
