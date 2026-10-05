import "./mounted-folders.css";

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useOwnerWindow } from "#renderer/hooks/owner-window/useOwnerWindow.js";
import { useClock } from "#renderer/services/platform/hooks/useClock.js";
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { formatCount } from "#renderer/lib/wire/figures.js";
import { useSettlementAnnouncement } from "#renderer/hooks/useSettlementAnnouncement.js";
import { usePushDrivenRead } from "#renderer/store/reads/hooks/usePushDrivenRead.js";
import type { SettingsPageContext } from "#renderer/features/settings/types.js";
import { MountedFolderRow } from "./MountedFolderRow.js";
import { type PushDrivenReadState } from "#renderer/store/reads/push-driven-read.js";
import {
  createMountInventoryRead,
  type MountInventory,
  type MountInventoryCalls,
} from "./mount-inventory/mount-inventory.js";

/**
 * The list itself: the session's mounts, read and kept current.
 *
 * Its own component because the read's lifetime is this component's: built on the session
 * it reads, started in an effect, and disposed when the pane leaves.
 */
export function MountedFolderList(props: {
  readonly bridge: SettingsPageContext["bridge"];
  readonly calls: MountInventoryCalls;
  readonly sessionId: string;
  readonly sessionStore: SettingsPageContext["retainedSessionStore"];
}): ReactNode {
  const { bridge, calls, sessionId, sessionStore } = props;
  // The scenario's frozen clock under the fixture, the real one otherwise. It comes from
  // the window's clock hook, which keeps one identity for the mount, so this read is not
  // rebuilt around a new clock when the bridge is replaced.
  const clock = useClock();
  const ownerWindow = useOwnerWindow();
  // A dependency that moves the read's construction: a subscription that could not be
  // opened is terminal without one, because the read requests no snapshot then and the
  // effect below re-runs only when the session or the transport moves.
  const [openingOrdinal, setOpeningOrdinal] = useState(0);
  const inventoryRead = useMemo(
    () => createMountInventoryRead({ calls, sessionId, clock, sessionStore }),
    // `openingOrdinal` is the re-open: moving it builds a fresh read, and the effect below
    // disposes the previous one first, so release and re-subscribe are one act.
    [calls, sessionId, clock, sessionStore, openingOrdinal],
  );
  useEffect(() => {
    inventoryRead.start();
    return () => {
      inventoryRead.dispose();
    };
  }, [inventoryRead]);
  // Focus is the second of the section's three refresh signals: a window that was away may
  // have missed a mount going unreachable. It goes through the read's scheduler, so a
  // flurry of focus changes costs one read. The first signal is the session's event stream,
  // bound by the read (see `mount-inventory.ts`).
  useEffect(() => {
    const onWindowFocus = (): void => {
      inventoryRead.refresh("window-focus");
    };
    ownerWindow.addEventListener("focus", onWindowFocus);
    return () => {
      ownerWindow.removeEventListener("focus", onWindowFocus);
    };
  }, [inventoryRead, ownerWindow]);
  // Reconnect is the third, and a different fact: a window that never lost focus can still
  // have had its transport drop and come back, leaving everything read across the gap stale
  // with nothing on screen saying so. A separate effect from focus because the two release
  // differently: the focus listener is the window's, the reconnect subscription the
  // transport's.
  useEffect(
    () =>
      bridge.transportReconnect.subscribe(() => {
        inventoryRead.refresh("reconnect");
      }),
    [bridge, inventoryRead],
  );

  const state = usePushDrivenRead(inventoryRead);
  // Said once when the inventory lands, and again only if a later refresh settles
  // differently. The focus refresh re-reads on every return, so the sentence names counts
  // and nothing that moves on its own.
  useSettlementAnnouncement(mountSettlementSentence(state));

  if (state.kind === "not-loaded") {
    return <Nothing kind="not-loaded" placement="block" title="Reading this session's mounts." />;
  }
  if (state.kind === "failed") {
    // The control is the way back. A failed read recovers when the event stream pushes
    // again, but a subscription that could not be opened leaves nothing to push, and the
    // read asks for no snapshot then rather than render an inventory behind a channel that
    // has stopped listening.
    return (
      <Nothing
        kind="error"
        placement="block"
        title={state.refusal.code}
        detail={state.refusal.detail}
        action={
          <button
            type="button"
            className="meridian-settings-page__action meridian-action-button"
            onClick={() => {
              setOpeningOrdinal((held) => held + 1);
            }}
          >
            Try again
          </button>
        }
      />
    );
  }
  if (state.value.readings.length === 0) {
    return (
      <Nothing kind="empty" placement="block" title="This session has mounted no repositories." />
    );
  }
  return (
    <>
      <ul className="meridian-mount-list">
        {state.value.readings.map((mount) => (
          <li key={mount.id} className="meridian-mount-list__item">
            <MountedFolderRow mount={mount} />
          </li>
        ))}
      </ul>
      {state.value.unreadMountCount > 0 ? (
        <p className="meridian-settings-page__aside">
          {formatCount(state.value.unreadMountCount)} further mounts in this session were not read.
          The inventory opens a bounded number of mounts per visit.
        </p>
      ) : null}
    </>
  );
}

/**
 * The one sentence this list announces, or `undefined` while the read is in flight.
 *
 * The counts are what speech lacks: on screen the rows are the count. The unread tail is
 * named in the same sentence, since a bounded read that said only what it opened would
 * report a smaller session. A refused read speaks the refusal's own detail, the words the
 * card shows.
 */
function mountSettlementSentence(state: PushDrivenReadState<MountInventory>): string | undefined {
  if (state.kind === "not-loaded") {
    return undefined;
  }
  if (state.kind === "failed") {
    return state.refusal.detail;
  }
  const { readings, unreadMountCount } = state.value;
  if (readings.length === 0) {
    return "Mounts read for this session: it has mounted no repositories.";
  }
  return unreadMountCount === 0
    ? `Mounts read for this session: ${formatCount(readings.length)}.`
    : `Mounts read for this session: ${formatCount(readings.length)}, ` +
        `with ${formatCount(unreadMountCount)} more not read.`;
}
