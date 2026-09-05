import { Nothing } from "../../primitives/index.js";
import { type RepoMountsReading } from "./repo-mounts-reader.js";
import { NOT_READ_TITLE } from "./repo-mounts-copy.js";

/**
 * The collapsed line.
 *
 * A collapsed section has one line of room, and the sidebar decided to collapse it,
 * so the line reports the fact that decision was made against rather than repeating
 * the section's name back.
 */
export function RepoMountsSummary(props: {
  readonly reading: RepoMountsReading;
}): React.JSX.Element {
  const { reading } = props;
  if (reading.refusal !== undefined) {
    return <Nothing kind="error" title={reading.refusal.code} detail={reading.refusal.detail} />;
  }
  if (reading.status === "reading") {
    return <Nothing kind="computing" title="Reading repo mounts." />;
  }
  if (reading.status === "not-read") {
    return <Nothing kind="not-checked" title={NOT_READ_TITLE} />;
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
