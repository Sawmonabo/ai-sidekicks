import type { RepoMountReadResponse } from "@ai-sidekicks/contracts/repo/folders";
import type { ReactNode } from "react";
import { Chip } from "#renderer/components/Chip/Chip.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { codeWords } from "#renderer/lib/code-words.js";
import { mountHealthReading, mountLifecycleReading } from "#renderer/store/mount-axis-readings.js";
import { formatDateTime, formatZonedDateTime } from "#renderer/lib/wire/figures.js";
import { useClockLocale } from "#renderer/services/platform/hooks/useClockLocale.js";

/** One row: the path, the two axes, and when the mount was last probed. */
export function MountedFolderRow(props: { readonly mount: RepoMountReadResponse }): ReactNode {
  const clockLocale = useClockLocale();
  const { mount } = props;
  const lifecycle = mountLifecycleReading(mount.state);
  const health = mountHealthReading(mount.health);
  return (
    <div className="meridian-mount-list__row">
      <span className="meridian-mount-list__path">
        <WireFigure value={mount.localPath} />
      </span>
      <span className="meridian-mount-list__root">
        <WireFigure value={mount.canonicalRoot} />
      </span>
      <span className="meridian-mount-list__axes">
        <Chip tone={lifecycle.tone} label={`Attachment: ${lifecycle.label}`} glyph="dot" />
        <Chip tone={health.tone} label={`Health: ${health.label}`} glyph="clock" />
        <Chip tone="neutral" label={codeWords(mount.vcsType)} />
      </span>
      <span className="meridian-mount-list__probe">
        Last probed at{" "}
        <WireFigure
          value={formatDateTime(mount.health.checkedAt, clockLocale)}
          title={formatZonedDateTime(mount.health.checkedAt, clockLocale)}
        />
      </span>
    </div>
  );
}
