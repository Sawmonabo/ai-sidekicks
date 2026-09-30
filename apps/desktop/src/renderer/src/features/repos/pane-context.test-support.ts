import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import type { PaneAddress } from "@renderer/routing/panes/pane-address.js";
import type { PaneContext } from "@renderer/registries/panes/pane-context.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";

/**
 * A pane context at one address, with whichever collaborators the case reaches. The address
 * half is `PaneAddress`'s own union, so a pane handed a subject it is never opened over fails to
 * compile. The binding half is cast: no co-located case observes the persistence stack.
 */
export function paneContext<TAddress extends PaneAddress>(reached: {
  readonly address: TAddress;
  readonly paneId: string;
  readonly bridge?: PlatformBridge | undefined;
  readonly sessionStore?: SessionStore | undefined;
}): Extract<PaneContext, TAddress> {
  return {
    ...reached.address,
    paneId: reached.paneId,
    bridge: reached.bridge,
    sessionStore: reached.sessionStore,
  } as unknown as Extract<PaneContext, TAddress>;
}
