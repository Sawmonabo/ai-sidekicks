import type { ReactNode } from "react";
import { Chip, InlineRefusal, WireFigure, formatDateTime } from "../../../primitives/index.js";
import { type MountReading } from "./mount-inventory.js";
import { attachmentTone, reachabilityTone } from "./WorkspaceMountsPage.js";

/** One row: the path, the two axes, and whatever the read had to say about it. */
export function MountRow(props: { readonly reading: MountReading }): ReactNode {
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
