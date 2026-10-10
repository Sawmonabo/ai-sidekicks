// The settings screen: the page list, the pane holding one page, and the search above the list.
//
// No entry is hidden because its wire is unavailable (the list is the closed set of pages),
// nothing here awaits a page read, and the open page lives in the route, so a link and a press
// on the list are the same act and Back works. The pane resolves its page during render from the
// registry it is handed, which is built before the first render, so an effect would paint
// "missing" first. A window too narrow for both panes shows one at a time: the list alone on the
// address that names no page, and a page under `‹ Settings`. Before the background service first
// answers, the open page draws its heading and note over an empty body, since its body reads it.

import "./SettingsScreen.css";

import { useCallback, useId, useState } from "react";
import { useWindowStore } from "#renderer/store/window/hooks/useWindowStore.js";
import { useMainProcessState } from "#renderer/store/window/hooks/useMainProcessState.js";
import { useOpenSessionStore } from "#renderer/store/session/hooks/useOpenSessionStore.js";
import { settingsRoute, settingsSelection } from "#renderer/routing/readers.js";
import type { ScreenContext } from "#renderer/registries/screens/context.js";
import { type SettingsPageRegistry } from "./pages/registry.js";
import type { SettingsPageContext } from "./types.js";
import type { SettingsSearchHit } from "./search.js";
import { SETTINGS_PAGE_IDS, type SettingsPageId } from "#renderer/routing/settings-page-ids.js";
import { useCommitEditedFieldOnLeave } from "./hooks/useCommitEditedFieldOnLeave.js";
import { useFocusShownPane } from "./hooks/useFocusShownPane.js";
import { useLastSettingsPageId } from "./hooks/useLastSettingsPageId.js";
import { PendingSearchHit } from "./pending-search-hit.js";
import { useSettingsPageIdleWarm } from "./hooks/useSettingsPageIdleWarm.js";
import { useSettingsPaneArrangement } from "./hooks/useSettingsPaneArrangement.js";
import { useSettingsSearch } from "./hooks/useSettingsSearch.js";
import { SettingsSearchField } from "./components/SettingsSearchField.js";
import { SettingsPageList } from "./components/SettingsPageList.js";
import { SettingsSearchResults } from "./components/SettingsSearchResults.js";
import { SettingsPane } from "./components/SettingsPane.js";

/** Props for {@link SettingsScreen}. */
export interface SettingsScreenProps {
  readonly context: ScreenContext;
  /**
   * The pages this screen may render.
   *
   * A prop, not a singleton: tests supply their own registry.
   */
  readonly pages: SettingsPageRegistry;
}

/** The settings screen: page list, search, and the pane for the open page. */
export function SettingsScreen(props: SettingsScreenProps): React.JSX.Element {
  const { context, pages } = props;
  const { route, frameStore } = context;
  const requestedPage = route.kind === "settings" ? route.page : undefined;
  // The route accessor is the one reader of the selection union.
  const selection = settingsSelection(route);
  const currentPageId = pageIdFor(requestedPage);
  // A counter, not a boolean: each search hit lands again, including a second hit on the
  // control already open, and a boolean already true would change nothing.
  const [hitOrdinal, setHitOrdinal] = useState(0);
  const [pendingSearchHit] = useState(() => new PendingSearchHit());
  // State rather than refs, so what measures and watches these boxes starts once they mount.
  const [screen, setScreen] = useState<HTMLElement | null>(null);
  const [listPane, setListPane] = useState<HTMLDivElement | null>(null);
  const [pagePane, setPagePane] = useState<HTMLDivElement | null>(null);
  const hitsId = useId();
  // Subscribed, not read once: a getter read during render would not re-render when a session
  // opens in another destination.
  const retainedSessionId = useWindowStore(frameStore, (state) => state.lastOpenedSessionId);

  const openPage = useCallback(
    (pageId: SettingsPageId): void => {
      frameStore.navigate(settingsRoute(pageId, undefined));
    },
    [frameStore],
  );
  // A cursor move only follows the keys, so it takes the place of the page it left in the
  // window's history rather than adding one Back would have to walk through.
  const followCursorToPage = useCallback(
    (pageId: SettingsPageId): void => {
      frameStore.replaceRoute(settingsRoute(pageId, undefined));
    },
    [frameStore],
  );
  const openSearchHit = useCallback(
    (hit: SettingsSearchHit): void => {
      pendingSearchHit.hold(hit.pageId);
      frameStore.navigate(settingsRoute(hit.pageId, hit.controlId));
      setHitOrdinal((held) => held + 1);
    },
    [frameStore, pendingSearchHit],
  );
  const showPageList = useCallback((): void => {
    frameStore.navigate({ kind: "settings", page: undefined });
  }, [frameStore]);

  const search = useSettingsSearch(pages, openSearchHit);
  const restingPageId = useLastSettingsPageId(context.lastSettingsPage, currentPageId);
  const arrangement = useSettingsPaneArrangement({
    screen,
    pagePane,
    requestedPage,
  });
  useCommitEditedFieldOnLeave(frameStore, pagePane);
  const isOneAtATime = arrangement === "one-at-a-time";
  const isShowingPage = requestedPage !== undefined;
  useFocusShownPane({
    listPane,
    pagePane,
    shownPane: isOneAtATime ? (isShowingPage ? "page" : "list") : "both",
  });

  // The retained session, never the route's projection: every settings address names no
  // session, so a session-scoped page handed the projection would always render its
  // no-session arm. It is resolved here so a page cannot open a session during render;
  // `undefined` when this window has that session closed.
  const retainedSessionStore = useOpenSessionStore(context.sessionStoreRegistry, retainedSessionId);

  // One subscription per window; this reads it.
  const mainProcessState = useMainProcessState(frameStore);

  const pageContext: SettingsPageContext = {
    bridge: context.bridge,
    openPage,
    selection,
    retainedSessionId,
    retainedSessionStore,
    mainProcessState,
    chooseScheme: context.chooseScheme,
  };

  // Warm the deferred pages at idle: a person reads the list before choosing a page.
  useSettingsPageIdleWarm(pages);

  const hitIdAt = (hitIndex: number): string => `${hitsId}-${String(hitIndex)}`;

  return (
    <section
      ref={setScreen}
      className="meridian-settings"
      data-arrangement={arrangement}
      aria-label="Settings"
    >
      <div
        ref={setListPane}
        className="meridian-settings__list-pane"
        hidden={isOneAtATime && isShowingPage}
      >
        <SettingsSearchField
          query={search.query}
          onQueryChange={search.setQuery}
          onKeyDown={search.onFieldKeyDown}
          hitsId={search.isSearching && search.hits.length > 0 ? hitsId : undefined}
          highlightedHitId={
            search.isSearching && search.highlightedIndex !== undefined
              ? hitIdAt(search.highlightedIndex)
              : undefined
          }
        />
        {search.isSearching ? (
          <SettingsSearchResults
            hitsId={hitsId}
            query={search.query}
            hits={search.hits}
            highlightedIndex={search.highlightedIndex}
            hitIdAt={hitIdAt}
            onOpenHit={openSearchHit}
          />
        ) : null}
        <SettingsPageList
          currentPageId={currentPageId}
          restingPageId={restingPageId}
          onOpenPage={openPage}
          onCursorMove={isOneAtATime ? undefined : followCursorToPage}
          isCollapsed={search.isSearching}
        />
      </div>
      <div
        ref={setPagePane}
        className="meridian-settings__pane"
        hidden={isOneAtATime && !isShowingPage}
      >
        <SettingsPane
          pageId={currentPageId}
          attempted={requestedPage}
          context={pageContext}
          pages={pages}
          hitOrdinal={hitOrdinal}
          pendingSearchHit={pendingSearchHit}
          isPageBodyDrawn={context.hasServiceAnswered}
          onShowPageList={isOneAtATime ? showPageList : undefined}
        />
      </div>
    </section>
  );
}

/** The page a `#/settings/<page>` address names, or `undefined` for none of them. */
function pageIdFor(page: string | undefined): SettingsPageId | undefined {
  return SETTINGS_PAGE_IDS.find((pageId) => pageId === page);
}
