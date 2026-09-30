// The settings screen: a rail of sections, a pane holding one, and a search that reaches both.
//
// No rail entry is hidden because its wire is unavailable (the rail is the closed section
// tuple), nothing here awaits a section read, and the only state held is the search query. The
// open section lives in the route, so a deep link and a rail click are the same act and back
// works. The pane resolves its page during render: the registry is composed at module scope, so
// an effect would paint "missing" first.

import { useCallback, useMemo, useState } from "react";
import { useWindowStore } from "@renderer/store/window/hooks/useWindowStore.js";
import { useMainProcessState } from "@renderer/store/window/hooks/useMainProcessState.js";
import { useOpenSessionStore } from "@renderer/store/session/hooks/useOpenSessionStore.js";
import { settingsSelection } from "@renderer/routing/route-readers.js";
import type { ScreenContext } from "@renderer/registries/screens/screen-context.js";
import { matchSettingsPages, type SettingsPageRegistry } from "./settings-pages.js";
import type { SettingsPageContext } from "./types.js";
import { SETTINGS_PAGE_IDS, type SettingsPageId } from "@renderer/routing/settings-page-ids.js";
import { useSettingsPageIdleWarm } from "./hooks/useSettingsPageIdleWarm.js";
import { SettingsSearchField } from "./components/SettingsSearchField.js";
import { SettingsPageList } from "./components/SettingsPageList.js";
import { SettingsSearchResults } from "./components/SettingsSearchResults.js";
import { SettingsPane } from "./components/SettingsPane.js";

/** Props for {@link SettingsScreen}. */
export interface SettingsScreenProps {
  readonly context: ScreenContext;
  /**
   * The pages this pane may render.
   *
   * A prop, not a singleton: tests supply their own registry.
   */
  readonly pages: SettingsPageRegistry;
}

/** The settings screen: page rail, search, and the pane for the open section. */
export function SettingsScreen(props: SettingsScreenProps): React.JSX.Element {
  const { context, pages } = props;
  const { route } = context;
  const requestedPage = route.kind === "settings" ? route.page : undefined;
  // The route accessor is the one reader of the selection union.
  const selection = settingsSelection(route);
  const selectedSection = requestedSection(requestedPage);
  const [searchQuery, setSearchQuery] = useState("");
  // A counter, not a boolean: each search hit must settle the pane, including a second hit on
  // the same section, and a boolean already true would change nothing.
  const [settleOrdinal, setSettleOrdinal] = useState(0);
  // Subscribed, not read once: a getter read during render would not re-render when a session
  // opens in another destination.
  const retainedSessionId = useWindowStore(
    context.frameStore,
    (state) => state.lastOpenedSessionId,
  );

  const openPage = useCallback(
    (section: SettingsPageId): void => {
      context.frameStore.navigate({ kind: "settings", page: section });
    },
    [context.frameStore],
  );

  /** Open a section from a search hit; unlike a rail press, the pane must show where it landed. */
  const openSearchHit = useCallback(
    (section: SettingsPageId): void => {
      openPage(section);
      setSettleOrdinal((held) => held + 1);
    },
    [openPage],
  );

  // The retained session, never the route's projection: every settings address names no
  // session, so a session-scoped page handed the projection would always render its
  // no-session arm. It is resolved here so a page cannot open a session during render;
  // `undefined` when this window has that session closed.
  const retainedSessionStore = useOpenSessionStore(context.sessionStoreRegistry, retainedSessionId);

  // One subscription per window; this reads it.
  const mainProcessState = useMainProcessState(context.frameStore);

  const pageContext: SettingsPageContext = {
    bridge: context.bridge,
    openPage,
    selection,
    retainedSessionId,
    retainedSessionStore,
    mainProcessState,
    uiStateStore: context.uiStateStore,
    chooseScheme: context.chooseScheme,
  };

  // Warm the deferred pages at idle: a person reads the rail before choosing a section.
  useSettingsPageIdleWarm(pages);

  // Memoized because the registry is fixed while a window is open.
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
          <SettingsPageList selectedSection={selectedSection} onOpenSection={openPage} />
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
function requestedSection(page: string | undefined): SettingsPageId | undefined {
  return SETTINGS_PAGE_IDS.find((section) => section === page);
}
