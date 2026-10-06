// What a pane body is handed. It sits below `registry.ts` because the registry reaches
// `PendingPaneBody.tsx` and `PaneFrame.tsx`, which both name this context; declaring it in the
// registry would make a cycle through type imports, which the layering check counts. It imports
// nothing from this folder.
import { type PlatformBridge } from "#renderer/services/platform/bridge.js";
import { type DraftStore } from "#renderer/store/drafts.js";
import { type UiStateStore } from "#renderer/store/persistence/ui-state-store.js";
import { type WindowStore } from "#renderer/store/window/store.js";
import { type SessionStore } from "#renderer/store/session/store.js";
import { type PaneAddress } from "#renderer/routing/panes/address.js";

/**
 * Everything a pane body is handed; all of it is per pane, in the window the pane is mounted in.
 * An intersection because the address is a union over `kind`, so narrowing a context on `kind`
 * narrows its `entity` too.
 */
export type PaneContext = PaneAddress & PaneBinding;

/** What a pane is bound to, beside the address it was opened at. */
interface PaneBinding {
  /** This pane's identity in the pane layout, stable across a layout restore. */
  readonly paneId: string;
  readonly bridge: PlatformBridge;
  readonly frameStore: WindowStore;
  /** The session store for the pane's session, or `undefined` on a bare route. */
  readonly sessionStore: SessionStore | undefined;
  readonly uiStateStore: UiStateStore;
  readonly draftStore: DraftStore;
  /**
   * The pane this one was opened from, when the layout linked the two. It is an id, never a handle,
   * so a linked pane stays independently movable and closable. Required and `undefined` when
   * unlinked, so forgetting to pass it is not mistaken for a decision.
   */
  readonly linkedSourcePaneId: string | undefined;
}
