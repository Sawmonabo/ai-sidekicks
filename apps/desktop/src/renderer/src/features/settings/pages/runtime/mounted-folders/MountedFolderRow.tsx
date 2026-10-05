import type { RepoMountReadResponse } from "@ai-sidekicks/contracts/repo/folders";
import type { ReactNode } from "react";
import { Chip } from "@renderer/components/Chip/Chip.js";
import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";
import { formatDateTime } from "@renderer/lib/wire-figures.js";

/** One row: the path, the two axes, and when the mount was last probed. */
export function MountedFolderRow(props: { readonly mount: RepoMountReadResponse }): ReactNode {
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
 * How the lifecycle axis is toned: a presentation of the daemon's value, never a verdict.
 * The value renders verbatim beside the tone, so a color never stands in for a state name.
 */
function attachmentTone(mount: RepoMountReadResponse): "neutral" | "attention" {
  return mount.state === "attached" ? "neutral" : "attention";
}

/**
 * The same, for the health axis. The two are toned independently.
 *
 * The axis is health, not reachability: `RepoMountHealth` has three verdicts and only one
 * is about reachability. `identity_mismatch` names a root that was reached and is no longer
 * the repository it was attached as. Anything but `healthy` is a failure a person has to
 * act on.
 */
function mountHealthTone(mount: RepoMountReadResponse): "neutral" | "failure" {
  return mount.health.status === "healthy" ? "neutral" : "failure";
}
