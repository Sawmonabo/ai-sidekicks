import { useEffect, useMemo } from "react";
import type { ReactNode } from "react";
import { consoleClockFor } from "../../../bridge/index.js";
import { Nothing, formatCount, useSettlementAnnouncement } from "../../../primitives/index.js";
import { usePushDrivenRead } from "../../../seats/index.js";
import { createMountInventoryRead } from "./mount-inventory.js";
import type { SettingsPageContext } from "../../settings-page-registry.js";
import { MountRow } from "./MountRow.js";
import { type PushDrivenReadState } from "../../../seats/index.js";
import { type MountInventory, type MountReading } from "./mount-inventory.js";

/**
 * The list itself, mounted only when there is a session to read for.
 *
 * A separate component because the read's lifetime is this component's: it is
 * constructed on the session it reads, started in an effect, and disposed when the
 * pane leaves — none of which can be arranged from a parent that renders the
 * absence instead.
 */
export function MountInventoryList(props: {
  readonly bridge: SettingsPageContext["bridge"];
  readonly sessionId: string;
  readonly sessionStore: SettingsPageContext["retainedSessionStore"];
}): ReactNode {
  const { bridge, sessionId, sessionStore } = props;
  // The scenario's frozen clock under the fixture, the real one otherwise, through
  // the bridge family's own door — the same resolution eleven other sites make, so a
  // story advances this read's coalescing window exactly when it advances everything
  // else's, and a third arm on that resolution reaches here with them.
  const inventoryRead = useMemo(
    () =>
      createMountInventoryRead({
        bridge,
        sessionId,
        clock: consoleClockFor(bridge),
        sessionStore,
      }),
    [bridge, sessionId, sessionStore],
  );
  useEffect(() => {
    inventoryRead.start();
    return () => {
      inventoryRead.dispose();
    };
  }, [inventoryRead]);
  // Focus is the second of the section's three signals and not a poll: a window
  // that was away may have missed a mount going unreachable, and the request goes
  // through the read's own scheduler so a flurry of focus changes still costs one
  // read. The first is the session's own event stream, bound by the read itself
  // (see `mount-inventory.ts`, which also says why the third — reconnect — is bound
  // nowhere in this console).
  useEffect(() => {
    const onWindowFocus = (): void => {
      inventoryRead.refresh("window-focus");
    };
    window.addEventListener("focus", onWindowFocus);
    return () => {
      window.removeEventListener("focus", onWindowFocus);
    };
  }, [inventoryRead]);

  const state = usePushDrivenRead(inventoryRead);
  // Said once, when the inventory lands — and once more only if a later refresh
  // settles differently. The focus refresh above re-reads this list every time the
  // window comes back, so the sentence deliberately names the counts and nothing
  // that moves on its own; an unchanged inventory read again says nothing again.
  useSettlementAnnouncement(mountSettlementSentence(state));

  if (state.kind === "not-loaded") {
    return <Nothing kind="not-loaded" placement="surface" title="Reading this session's mounts." />;
  }
  if (state.kind === "failed") {
    return (
      <Nothing
        kind="error"
        placement="surface"
        title={state.refusal.code}
        detail={state.refusal.detail}
      />
    );
  }
  if (state.value.readings.length === 0) {
    return (
      <Nothing
        kind="empty"
        placement="surface"
        title="This session has mounted no repositories."
        detail="A mount arrives when a repository is attached to this session from the workspace surface."
      />
    );
  }
  return (
    <>
      <ul className="meridian-mount-list">
        {state.value.readings.map((reading) => (
          <li key={mountKeyOf(reading)} className="meridian-mount-list__item">
            <MountRow reading={reading} />
          </li>
        ))}
      </ul>
      {state.value.unreadMountCount > 0 ? (
        <p className="meridian-settings-page__aside">
          {formatCount(state.value.unreadMountCount)} further mounts in this session were not read.
          The inventory opens a bounded number of mounts per visit, and the rest are named by the
          workspace surface rather than dropped here without saying so.
        </p>
      ) : null}
    </>
  );
}

/**
 * The row's key: the mount id on both arms.
 *
 * The refused arm has no reply to take an id from, which is exactly why the read
 * carries the requested id on it — so a mount that refuses on one read and answers
 * on the next keeps its row rather than remounting as a different one.
 */
export function mountKeyOf(reading: MountReading): string {
  return reading.kind === "read" ? reading.mount.id : reading.repoMountId;
}

/**
 * The one sentence this list announces, or `undefined` while the read is in flight.
 *
 * The counts are what a person cannot get any other way: on screen the rows ARE the
 * count, and spoken they are not. The unread tail is named in the same sentence rather
 * than dropped, for the reason the aside beside it exists — a bounded read that said
 * only what it opened would report a smaller session than the one it found.
 *
 * A refused read speaks the refusal's own detail, never a sentence of this console's
 * own: the card on screen renders those words, and the announcement is the spoken half
 * of the same fact rather than a second, friendlier account of it.
 */
export function mountSettlementSentence(
  state: PushDrivenReadState<MountInventory>,
): string | undefined {
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
    : `Mounts read for this session: ${formatCount(readings.length)}, with ${formatCount(unreadMountCount)} more not read.`;
}
