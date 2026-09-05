import type { ReactNode } from "react";

import type { RepoMountReadResponse } from "@ai-sidekicks/contracts";
import { Nothing, formatCount } from "../../../primitives/index.js";
import { type PushDrivenReadState } from "../../../seats/index.js";
import { type MountInventory, type MountReading } from "./mount-inventory.js";
import type { SettingsPageContext, SettingsPageRegistry } from "../../settings-page-registry.js";
import "./mounts.css";
import { MountInventoryList } from "./MountInventoryList.js";

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
 * How the lifecycle axis is toned. A PRESENTATION of the daemon's own value and
 * never a verdict: the value renders verbatim beside the tone, so a reader is never
 * shown a colour in place of a state name.
 */
export function attachmentTone(mount: RepoMountReadResponse): "neutral" | "attention" {
  return mount.state === "attached" ? "neutral" : "attention";
}

/** The same, for the reachability axis. The two are toned independently. */
export function reachabilityTone(mount: RepoMountReadResponse): "neutral" | "failure" {
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
