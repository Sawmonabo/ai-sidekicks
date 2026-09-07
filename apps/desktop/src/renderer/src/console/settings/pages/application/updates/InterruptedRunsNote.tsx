import { DerivedFigure, WireFigure, formatCount } from "../../../../primitives/index.js";
import { useSessionPartition, type SessionStore } from "../../../../store/index.js";
import { tallyLiveRuns } from "./restart-impact.js";

/**
 * Which runs of the open session a restart would interrupt.
 *
 * A component of its own because the partition subscription is a hook, and the arm
 * that has no session to subscribe to must not call it — the same shape
 * `MountInventoryList.tsx` takes, where the reading lives in the component that only
 * mounts once there is a session for it to read.
 *
 * PHRASING CONTENT ONLY. This renders inside `AlertDialog.Description`, which Base UI
 * draws as a `<p>`, so the whole note is spans and text.
 *
 * The counts are `DerivedFigure`s — the console counted them — while each run id is a
 * `WireFigure`, because an id is the daemon's own string and rule 4 renders one
 * verbatim, in mono, never abbreviated.
 */
export function InterruptedRunsNote(props: {
  readonly sessionStore: SessionStore;
}): React.JSX.Element {
  const runs = useSessionPartition(props.sessionStore, "run");
  const tally = tallyLiveRuns(runs);
  if (tally.liveRunCount === 0) {
    return <span>No run in the session this window has open is still moving.</span>;
  }
  return (
    <span>
      <DerivedFigure text={formatCount(tally.liveRunCount)} />
      {tally.liveRunCount === 1
        ? " run in the session this window has open is still moving: "
        : " runs in the session this window has open are still moving: "}
      {tally.namedRunIds.map((runId, position) => (
        <span key={runId}>
          {position === 0 ? "" : ", "}
          <WireFigure value={runId} />
        </span>
      ))}
      {tally.unnamedRunCount === 0 ? (
        "."
      ) : (
        <>
          {", and "}
          <DerivedFigure text={formatCount(tally.unnamedRunCount)} />
          {tally.unnamedRunCount === 1 ? " other." : " others."}
        </>
      )}
    </span>
  );
}
