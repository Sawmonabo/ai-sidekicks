// Two honesty notices about ways this install is quietly weaker than the default.
//
// They are INDEPENDENT. The transport and the keystore fail for unrelated reasons on
// unrelated hosts, so all four combinations are reachable and each notice stands or
// falls on its own fact. Folding them into one "degraded security" line would make a
// host with a working keyring and no OS-local transport read as if its sign-in were
// unprotected.
//
// NEITHER IS DISMISSIBLE, and that is a decision rather than an omission. A degraded
// security posture is not a detail behind a chevron: the condition is not something
// a person did, they cannot fix it from here, and a dismissal would only remove the
// one line telling them their sign-in dies at quit. Each clears when its own fact
// changes and by nothing else — which is also why neither carries an `onDismiss`
// even though the banner primitive offers one.
//
// AND NEITHER IS PROBED HERE. The keystore probe and the transport choice are
// main-process facts made at startup — the renderer never touches either — so this
// component renders what it was told and would render nothing at all if it were
// told nothing.

import { RefusalBanner } from "../../primitives/index.js";
import type { ShellKeystoreState, ShellTransport } from "../../store/index.js";
import { KEYSTORE_NOTICE, LOOPBACK_NOTICE } from "./shell-sentences.js";

export interface ShellNoticesProps {
  readonly transport: ShellTransport | undefined;
  readonly keystore: ShellKeystoreState | undefined;
}

/** Whichever of the two notices stand, or nothing where neither does. */
export function ShellNotices(props: ShellNoticesProps): React.JSX.Element | null {
  const showsLoopback = props.transport === "loopback";
  const showsKeystore = props.keystore === "unavailable";
  if (!showsLoopback && !showsKeystore) {
    return null;
  }
  return (
    <div className="meridian-shell-state__notices">
      {showsLoopback ? (
        <RefusalBanner
          code="transport-loopback"
          detail={`${LOOPBACK_NOTICE.title}. ${LOOPBACK_NOTICE.detail} ${LOOPBACK_NOTICE.remedy}`}
        />
      ) : null}
      {showsKeystore ? (
        <RefusalBanner
          code="keystore-unavailable"
          detail={`${KEYSTORE_NOTICE.title}. ${KEYSTORE_NOTICE.detail} ${KEYSTORE_NOTICE.remedy}`}
        />
      ) : null}
    </div>
  );
}
