import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { type RepoMountsReading } from "../repo-mounts-model.js";
import { REPO_MOUNTS_NOT_READ_TITLE } from "../repo-mounts-copy.js";

/** The collapsed sidebar line: how many mounts there are and how many are unreachable. */
export function RepoMountsSummary(props: {
  readonly reading: RepoMountsReading;
}): React.JSX.Element {
  const { reading } = props;
  if (reading.status === "reading") {
    return <Nothing kind="computing" title="Reading repo mounts." />;
  }
  if (reading.status === "not-read") {
    return <Nothing kind="not-checked" title={REPO_MOUNTS_NOT_READ_TITLE} />;
  }
  const unreachableCount = reading.mounts.filter(
    (mount) => mount.health.status !== "healthy",
  ).length;
  if (reading.mounts.length === 0) {
    return <Nothing kind="empty" title="No repository is attached." />;
  }
  return (
    <span className="meridian-repo-section__count">
      {reading.mounts.length} mounted
      {unreachableCount > 0 ? `, ${unreachableCount} unreachable` : ""}
    </span>
  );
}
