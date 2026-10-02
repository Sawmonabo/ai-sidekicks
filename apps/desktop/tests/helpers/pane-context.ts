// The one pane context builder, for every suite and tier that mounts a pane. A pane that reads
// no UI state gets a never-settling adapter by default: one that grows a UI-state read hangs and
// is found, where a settling stub would pass with an empty store. A mount whose pane hands the
// store on passes an answering one.
//
// The address is the parameter and is passed through as written, so the address union's shapes
// (session-scoped kinds carry no `entity`, entity-keyed kinds require one) are enforced at the call
// site.

import { MAXIMUM_LIVE_DRAFT_COUNT } from "@renderer/store/persistence-caps.js";
import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { DraftStore } from "@renderer/store/draft-store.js";
import { UiStateStore } from "@renderer/store/persistence/ui-state-store.js";
import { type PaneAddressOf } from "@renderer/routing/panes/pane-address.js";
import { type PaneKind } from "@renderer/routing/panes/pane-kinds.js";
import { type PaneContext } from "@renderer/registries/panes/pane-context.js";
import { WindowStore } from "@renderer/store/window/window-store.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";

/**
 * What a mounting suite decides. `bridge` and `sessionStore` are required with no default, since
 * a pane reads them and a default would be a fixture this module chose blind; `sessionStore` may
 * be `undefined` for a bare route.
 */
export interface PaneBindings {
  readonly bridge: PlatformBridge;
  readonly sessionStore: SessionStore | undefined;
  /** The pane this one was opened from, where a case is about the link. */
  readonly linkedSourcePaneId?: string;
  /**
   * The window store the pane escalates into, for a case that reads its banners; defaulted.
   * `| undefined` is spelled out because `exactOptionalPropertyTypes` rejects a forwarded
   * optional member under a bare `?`.
   */
  readonly frameStore?: WindowStore | undefined;
  /**
   * This pane's identity in the layout, for a case about which pane it is; defaulted from the
   * kind. A layout can move a position to another pane without remounting, so a suite proving
   * whose state a pane shows must hold two ids at once.
   */
  readonly paneId?: string | undefined;
  /** A UI-state store that answers, for a case about a UI-state read; opts out of the default. */
  readonly uiStateStore?: UiStateStore | undefined;
}

/**
 * The context a pane body is mounted with, over one address. The pane id defaults to
 * `pane-<kind>` unless {@link PaneBindings.paneId} names one. The return is the intersection, not
 * `PaneContextOf<TKind>`, which the compiler cannot evaluate while `TKind` is a parameter.
 */
export function paneContext<TKind extends PaneKind>(
  address: PaneAddressOf<TKind>,
  bindings: PaneBindings,
): PaneAddressOf<TKind> & PaneBindingMembers {
  return {
    ...address,
    paneId: bindings.paneId ?? `pane-${address.kind}`,
    linkedSourcePaneId: bindings.linkedSourcePaneId,
    bridge: bindings.bridge,
    frameStore: bindings.frameStore ?? new WindowStore(),
    sessionStore: bindings.sessionStore,
    // Never settles: a pane that grew a UI-state read hangs here instead of passing on a stub.
    uiStateStore:
      bindings.uiStateStore ?? new UiStateStore({ adapter: new Promise(() => undefined) }),
    draftStore: new DraftStore({ maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT }),
  };
}

/**
 * The binding half of a pane context, everything that is not the address. `Omit` over the whole
 * union keeps only the members every arm carries, so `entity` drops out without naming an arm.
 */
type PaneBindingMembers = Omit<PaneContext, "kind">;
