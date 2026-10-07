// The page pane: two empty states, or the page the address names, with the way back to the page
// list above it while the window shows one pane at a time.
//
// The page itself is `SettingsPageContent`, which holds hooks; this component may not, because
// both empty-state arms render before any page is resolved.
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { SettingsPageContent } from "./SettingsPageContent.js";
import type { SettingsPageRegistry } from "../pages/registry.js";
import type { SettingsPageContext } from "../types.js";
import type { SettingsPageId } from "#renderer/routing/settings-page-ids.js";
import type { PendingSearchHit } from "../pending-search-hit.js";

/** Props for {@link SettingsPane}. */
export interface SettingsPaneProps {
  readonly pageId: SettingsPageId | undefined;
  /** The address's own page part, so an unknown one can be named back. */
  readonly attempted: string | undefined;
  readonly context: SettingsPageContext;
  readonly pages: SettingsPageRegistry;
  /** Moves on every search hit, including a second hit on what is already open. */
  readonly hitOrdinal: number;
  /** The search hit waiting for the page it opened, which that page takes once. */
  readonly pendingSearchHit: PendingSearchHit;
  /** Returns to the page list; present only while the window shows one pane at a time. */
  readonly onShowPageList: (() => void) | undefined;
}

/**
 * The right-hand pane: the open page, or the reason there is none.
 *
 * Two empty states stay apart because the next move differs: no page chosen (`#/settings`
 * invites a choice rather than picking one, which would tie the choice to list order), and an
 * unknown page (an error, named back).
 */
export function SettingsPane(props: SettingsPaneProps): React.JSX.Element {
  const { onShowPageList } = props;
  return (
    <>
      {onShowPageList === undefined ? null : (
        <button
          type="button"
          className="meridian-settings__back"
          // The rail's own button is named Settings; this one steps back to the page list.
          aria-label="Back to the Settings pages"
          onClick={onShowPageList}
        >
          <span aria-hidden="true">‹</span> Settings
        </button>
      )}
      {renderPaneBody(props)}
    </>
  );
}

function renderPaneBody(props: SettingsPaneProps): React.JSX.Element {
  if (props.pageId !== undefined) {
    // Keyed by page, so two pages drawn from one component never share a field or its state.
    return (
      <SettingsPageContent
        key={props.pageId}
        pageId={props.pageId}
        context={props.context}
        pages={props.pages}
        hitOrdinal={props.hitOrdinal}
        pendingSearchHit={props.pendingSearchHit}
      />
    );
  }
  if (props.attempted !== undefined) {
    return (
      <Nothing
        kind="error"
        placement="block"
        title="That settings address does not name a page."
        detail={`Nothing in settings is called “${props.attempted}”. The page list names every page.`}
      />
    );
  }
  return (
    <Nothing
      kind="empty"
      placement="block"
      title="Choose a page."
      detail="Settings are grouped by what they govern. Search above to jump straight to one."
    />
  );
}
