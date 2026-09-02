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

import { RealClock } from "../../core/index.js";
import {
  Chip,
  InlineRefusal,
  Nothing,
  WireFigure,
  formatClockTime,
  formatCount,
} from "../../primitives/index.js";
import { usePushDrivenRead } from "../../collaboration/push-driven-read.js";
import { createMountInventoryRead, type MountReading } from "./mount-inventory.js";
import type { SettingsPageContext, SettingsPageRegistry } from "../settings-page-registry.js";

/** The lane that owns this page, so an unfilled section names someone. */
const OWNER = "collaboration-settings-mounts";

export function WorkspaceMountsPage(props: { readonly context: SettingsPageContext }): ReactNode {
  const { bridge, activeSessionId } = props.context;
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
        {activeSessionId === undefined ? (
          <Nothing
            kind="empty"
            placement="surface"
            title="Mounts belong to a session, and this address names none."
            detail="Open a session from the Sessions list and the repositories it has mounted render here. Nothing was asked of this machine for a session nobody named."
          />
        ) : (
          <MountInventoryList bridge={bridge} sessionId={activeSessionId} />
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
}): ReactNode {
  const { bridge, sessionId } = props;
  // The scenario's frozen clock under the fixture, the real one otherwise — the
  // same resolution the family's session models make, so a story advances this
  // read's coalescing window exactly when it advances everything else's.
  const inventoryRead = useMemo(
    () =>
      createMountInventoryRead({
        bridge,
        sessionId,
        clock: bridge.scenarioEngine?.clock ?? new RealClock(),
      }),
    [bridge, sessionId],
  );
  useEffect(() => {
    inventoryRead.start();
    return () => {
      inventoryRead.dispose();
    };
  }, [inventoryRead]);
  // Focus is a refresh reason and not a poll: a window that was away may have
  // missed a mount going unreachable, and the request goes through the read's own
  // scheduler so a flurry of focus changes still costs one read.
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
        <WireFigure
          value={formatClockTime(mount.health.checkedAt)}
          title={mount.health.checkedAt}
        />
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
