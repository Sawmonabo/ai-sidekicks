import type { RepoMountReadResponse } from "@ai-sidekicks/contracts";
import type { ReactNode } from "react";
import { Chip, WireFigure, formatDateTime } from "../../../primitives/index.js";

/** One row: the path, the two axes, and when the mount was last probed. */
export function MountRow(props: { readonly mount: RepoMountReadResponse }): ReactNode {
  const { mount } = props;
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
          tone={mountHealthTone(mount)}
          label={`Health: ${mount.health.status}`}
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
 * How the lifecycle axis is toned. A PRESENTATION of the daemon's own value and
 * never a verdict: the value renders verbatim beside the tone, so a reader is never
 * shown a color in place of a state name.
 */
export function attachmentTone(mount: RepoMountReadResponse): "neutral" | "attention" {
  return mount.state === "attached" ? "neutral" : "attention";
}

/**
 * The same, for the health axis. The two are toned independently.
 *
 * THE AXIS IS HEALTH AND NOT REACHABILITY, which is what the chip beside this says
 * too. `RepoMountHealth` carries three verdicts and only one of them is about whether
 * the root could be reached: `identity_mismatch` names a root that WAS reached and is
 * no longer the repository it was attached as, so a label promising reachability would
 * have been a false statement about the value printed next to it. The tone is right on
 * all three — anything but `healthy` is a failure a person has to act on — so this is
 * the name and the label moving to the axis, and no verdict changing.
 */
export function mountHealthTone(mount: RepoMountReadResponse): "neutral" | "failure" {
  return mount.health.status === "healthy" ? "neutral" : "failure";
}
