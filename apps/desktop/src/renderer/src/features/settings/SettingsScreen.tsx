// The settings surface: a rail of sections, a pane holding one, and a search that
// reaches both.
//
// THREE RULES THIS FILE IS THE ENFORCEMENT OF
//
//   • **No entry is hidden because its wire is unavailable.** The rail is the
//     closed section tuple, always all ten. A section whose page module is still
//     loading renders its reservation in the PANE. A section never costs a rail
//     entry, because a rail that shrinks when a daemon is unreachable is a rail that
//     teaches a person the setting does not exist.
//   • **The rail never blocks on a section read.** Nothing here awaits anything.
//     The rail is rendered from a closed tuple and the pane's read is the page's.
//   • **No second copy of a value a wire read owns.** The only state this surface
//     holds is the search query, which is a person's keystrokes and not a wire
//     value. Which section is open lives in the ROUTE, so a deep link and a rail
//     click are the same act and the back button works.
//
// The pane's own resolution happens during render, for `frame/composition/RouteSurface.tsx`'s
// reason: the registry is composed at module scope, so a page is there to be looked
// up on the first pass, and resolving in an effect would mean the first paint has
// already said the page is missing.

import { useCallback, useMemo, useState } from "react";
import { useFrameStore } from "@renderer/store/window/hooks/useWindowStore.js";
import { useShellState } from "@renderer/store/window/hooks/useMainProcessState.js";
import { useOpenSessionStore } from "@renderer/store/session/hooks/useOpenSessionStore.js";
import { settingsSelection } from "@renderer/routing/route-readers.js";
import type { ConsoleSurfaceContext } from "@renderer/console/seats/index.js";
import { matchSettingsPages, type SettingsPageRegistry } from "./settings-pages.js";
import type { SettingsPageContext } from "./types.js";
import {
  SETTINGS_SECTION_IDS,
  type SettingsSectionId,
} from "@renderer/console/settings/settings-sections.js";
import { useSettingsPageIdleWarm } from "./hooks/useSettingsPageIdleWarm.js";
import { SettingsSearchField } from "./components/SettingsSearchField.js";
import { SettingsPageList } from "./components/SettingsPageList.js";
import { SettingsSearchResults } from "./components/SettingsSearchResults.js";
import { SettingsPane } from "./components/SettingsPane.js";

export interface SettingsScreenProps {
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

export function SettingsScreen(props: SettingsScreenProps): React.JSX.Element {
  const { context, pages } = props;
  const { route } = context;
  const requestedPage = route.kind === "settings" ? route.page : undefined;
  // Through the routing family's own accessor rather than a narrowing written here:
  // the member is on one settings arm and off the other, and a second reader of that
  // union is a second chance to hand a page the selection a different address carried.
  const selection = settingsSelection(route);
  const selectedSection = requestedSection(requestedPage);
  const [searchQuery, setSearchQuery] = useState("");
  // ONE-SHOT, AND A COUNTER RATHER THAN A BOOLEAN. A search hit has to land the
  // reader in the pane and settle there — "a match names where it landed, scrolls
  // into the pane, and settles with one brief highlight" — and the second hit on the
  // SAME section has to settle again. A boolean cannot express that: it is already
  // true, so nothing downstream changes and the second press does nothing at all. The
  // ordinal moves on every hit, which is what makes each one an act.
  const [settleOrdinal, setSettleOrdinal] = useState(0);
  // SUBSCRIBED, not snapshotted. A getter read during render answers whatever the
  // store held on that pass and nothing re-renders when it changes, so a session
  // opened in another destination would reach these pages only on the next
  // unrelated render. The frame's own readers subscribe through this hook and so
  // does this one, which is also why the settings family holds no copy of the id.
  const retainedSessionId = useFrameStore(context.frameStore, (state) => state.lastOpenedSessionId);

  const openSection = useCallback(
    (section: SettingsSectionId): void => {
      context.frameStore.navigate({ kind: "settings", page: section });
    },
    [context.frameStore],
  );

  /**
   * Open a section from a SEARCH HIT, which is a different act from pressing a rail
   * entry: the rail already tells a person where they are, and a hit has to say
   * where it landed them.
   */
  const openSearchHit = useCallback(
    (section: SettingsSectionId): void => {
      openSection(section);
      setSettleOrdinal((held) => held + 1);
    },
    [openSection],
  );

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
    selection,
    retainedSessionId,
    retainedSessionStore,
    shellState,
    uiStateStore: context.uiStateStore,
    chooseScheme: context.chooseScheme,
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
    () => matchSettingsPages(pages.entries(), searchQuery),
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
            onOpenSection={openSearchHit}
          />
        ) : (
          <SettingsPageList selectedSection={selectedSection} onOpenSection={openSection} />
        )}
      </div>
      <div className="meridian-settings__pane">
        <SettingsPane
          section={selectedSection}
          attempted={requestedPage}
          context={pageContext}
          pages={pages}
          settleOrdinal={settleOrdinal}
        />
      </div>
    </section>
  );
}

/** The section a `#/settings/<page>` address names, or `undefined` for none of them. */
function requestedSection(page: string | undefined): SettingsSectionId | undefined {
  return SETTINGS_SECTION_IDS.find((section) => section === page);
}
