// The mounts page: what this session has mounted, and how each mount is doing.
//
// `Spec-023 §Console Design (Meridian)` §Workspace mounts: "Show what this node has
// mounted and hand off to the surface that manages it … One row per mount with its
// path and its two health axes … Never offers a detach control here. Never
// collapses the two mount health axes. Never polls."
//
// THE TWO AXES ARE THE WIRE'S OWN TWO, AND THEY ARE RENDERED SEPARATELY
//
// `RepoMountReadResponse` carries `state` — where the mount is in its lifecycle —
// and `health`, a probe verdict taken at read time with the instant it was taken.
// They have different owners and answer different questions, so they render as two
// chips with their own labels: a mount that is attached and unreachable reads as
// exactly that, and no third value is composed from the pair. Composing one is the
// thing the section forbids, because a recovery on one axis would then mask a
// degradation on the other.
//
// THE INVENTORY IS SESSION-SCOPED, AND THE PAGE SAYS SO
//
// `mount-inventory.ts` explains why: the only registered read that enumerates
// mounts is the session's workspace list. The section's own words are "what this
// node has mounted", and this page cannot honestly claim that scope, so it claims
// the one it can.
//
// TWO THINGS THE SECTION NAMES THAT THIS PAGE DOES NOT DRAW
//
//   • **No detach control.** The section forbids one here and nothing below offers
//     one — not disabled, not behind a disclosure.
//   • **No hand-off.** "Open the mount in its own surface" needs a surface, and the
//     console's pane-kind set is closed with no mount member and its route grammar
//     names none. The offer is absent with its reason rather than drawn as a
//     control that would land nowhere.

import { useEffect, useMemo } from "react";
import type { ReactNode } from "react";

import type { RepoMountReadResponse } from "@ai-sidekicks/contracts";

import { RealClock } from "../../../core/index.js";
import {
  Chip,
  InlineRefusal,
  Nothing,
  WireFigure,
  formatDateTime,
  formatCount,
  useSettlementAnnouncement,
} from "../../../primitives/index.js";
import { usePushDrivenRead, type PushDrivenReadState } from "../../../seats/index.js";
import {
  createMountInventoryRead,
  type MountInventory,
  type MountReading,
} from "./mount-inventory.js";
import type { SettingsPageContext, SettingsPageRegistry } from "../../settings-page-registry.js";

/** The lane that owns this page, so an unfilled section names someone. */
const OWNER = "collaboration-settings-mounts";

export function WorkspaceMountsPage(props: { readonly context: SettingsPageContext }): ReactNode {
  const { bridge, retainedSessionId, retainedSessionStore } = props.context;
  return (
    <div className="meridian-settings-page">
      <p className="meridian-settings-page__lede">
        A mount is a repository this session has bound to a machine. Every mount keeps two readings
        that are not the same question — where it is in its own lifecycle, and whether the path was
        reachable the last time somebody looked — and both are shown, because a mount can be
        perfectly attached and completely unreachable.
      </p>

      <section className="meridian-settings-page__block" aria-label="Mounted repositories">
        <h3 className="meridian-settings-page__block-title">Mounted repositories</h3>
        {retainedSessionId === undefined ? (
          <Nothing
            kind="empty"
            placement="surface"
            title="Mounts belong to a session, and this window has opened none."
            detail="Open a session from the Sessions list and the repositories it has mounted render here. Nothing was asked of this machine for a session nobody has opened."
          />
        ) : (
          <MountInventoryList
            bridge={bridge}
            sessionId={retainedSessionId}
            sessionStore={retainedSessionStore}
          />
        )}
      </section>

      <section className="meridian-settings-page__block" aria-label="Managing a mount">
        <h3 className="meridian-settings-page__block-title">Managing a mount</h3>
        <div className="meridian-settings-page__prose">
          <p>
            Attaching a repository, retiring one, and disposing of its working copies all belong to
            the workspace surface rather than to settings — this page is the inventory, not the
            controls. There is deliberately no detach here: detaching cascades through every
            workspace built on the mount, and a settings row is the wrong place to start something
            that large.
          </p>
        </div>
        <Nothing
          kind="not-checked"
          placement="inline"
          title="This console has nowhere to open a mount yet."
          detail="The surface that manages one mount has not been built here, so no row offers to open it. Nothing was asked, and no control is drawn that would lead nowhere."
        />
      </section>
    </div>
  );
}

/**
 * The list itself, mounted only when there is a session to read for.
 *
 * A separate component because the read's lifetime is this component's: it is
 * constructed on the session it reads, started in an effect, and disposed when the
 * pane leaves — none of which can be arranged from a parent that renders the
 * absence instead.
 */
function MountInventoryList(props: {
  readonly bridge: SettingsPageContext["bridge"];
  readonly sessionId: string;
  readonly sessionStore: SettingsPageContext["retainedSessionStore"];
}): ReactNode {
  const { bridge, sessionId, sessionStore } = props;
  // The scenario's frozen clock under the fixture, the real one otherwise — the
  // same resolution the family's session models make, so a story advances this
  // read's coalescing window exactly when it advances everything else's.
  const inventoryRead = useMemo(
    () =>
      createMountInventoryRead({
        bridge,
        sessionId,
        clock: bridge.scenarioEngine?.clock ?? new RealClock(),
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
    : `Mounts read for this session: ${formatCount(readings.length)}, with ${formatCount(unreadMountCount)} more not read.`;
}

/** One row: the path, the two axes, and whatever the read had to say about it. */
function MountRow(props: { readonly reading: MountReading }): ReactNode {
  if (props.reading.kind === "refused") {
    return (
      <div className="meridian-mount-list__row">
        <span className="meridian-mount-list__path">
          <WireFigure value={props.reading.repoMountId} />
        </span>
        <InlineRefusal code={props.reading.refusal.code} detail={props.reading.refusal.detail} />
      </div>
    );
  }
  const { mount } = props.reading;
  return (
    <div className="meridian-mount-list__row">
      <span className="meridian-mount-list__path">
        <WireFigure value={mount.localPath} />
      </span>
      <span className="meridian-mount-list__root">
        <WireFigure value={mount.canonicalRoot} />
      </span>
      <span className="meridian-mount-list__axes">
        <Chip tone={attachmentTone(mount)} label={`Attachment: ${mount.state}`} glyph="dot" />
        <Chip
          tone={reachabilityTone(mount)}
          label={`Reachability: ${mount.health.status}`}
          glyph="clock"
        />
        <Chip tone="neutral" label={mount.vcsType} mono />
      </span>
      <span className="meridian-mount-list__probe">
        Last probed at{" "}
        <WireFigure value={formatDateTime(mount.health.checkedAt)} title={mount.health.checkedAt} />
      </span>
    </div>
  );
}

/**
 * The row's key: the mount id on both arms.
 *
 * The refused arm has no reply to take an id from, which is exactly why the read
 * carries the requested id on it — so a mount that refuses on one read and answers
 * on the next keeps its row rather than remounting as a different one.
 */
function mountKeyOf(reading: MountReading): string {
  return reading.kind === "read" ? reading.mount.id : reading.repoMountId;
}

/**
 * How the lifecycle axis is toned. A PRESENTATION of the daemon's own value and
 * never a verdict: the value renders verbatim beside the tone, so a reader is never
 * shown a colour in place of a state name.
 */
function attachmentTone(mount: RepoMountReadResponse): "neutral" | "attention" {
  return mount.state === "attached" ? "neutral" : "attention";
}

/** The same, for the reachability axis. The two are toned independently. */
function reachabilityTone(mount: RepoMountReadResponse): "neutral" | "failure" {
  return mount.health.status === "healthy" ? "neutral" : "failure";
}

/** Claim the mounts section. See `RuntimeNodesPage.tsx` on the seam's shape. */
export function registerWorkspaceMountsPage(registry: SettingsPageRegistry): void {
  registry.register({
    section: "mounts",
    owner: OWNER,
    label: "Workspace mounts",
    keywords: ["repository", "repo", "worktree", "workspace", "path", "checkout", "clone"],
    render: (context) => <WorkspaceMountsPage context={context} />,
  });
}
