import { Nothing, RefusalCard } from "../../primitives/index.js";
import {
  type SidekickRegistrySnapshot,
  type SidekickRegistryView,
} from "./definition-registry-view.js";
import { NO_SAVED_SIDEKICKS } from "./definition-rows.js";
import { SavedSidekickRow } from "./SavedSidekickRow.js";

/** The saved column's four answers, one per arm of the reading. */
export function SavedSidekicks(props: {
  readonly snapshot: SidekickRegistrySnapshot;
  readonly view: SidekickRegistryView;
}): React.JSX.Element {
  const { snapshot, view } = props;
  const { reading } = snapshot;
  if (reading.kind === "not-loaded") {
    return (
      <Nothing
        kind="not-loaded"
        placement="surface"
        title="Reading the sidekicks saved on this node."
      />
    );
  }
  if (reading.kind === "refused") {
    return <RefusalCard code={reading.refusal.code} detail={reading.refusal.detail} />;
  }
  if (reading.kind === "empty") {
    return (
      <Nothing
        kind="empty"
        placement="surface"
        title={`${NO_SAVED_SIDEKICKS}.`}
        detail="Tuning one in a session and saving it puts it here, ready for the next session to start from."
      />
    );
  }
  return (
    <ul className="meridian-sidekicks__rows">
      {reading.rows.map((row) => (
        <li key={row.definitionId}>
          <SavedSidekickRow
            row={row}
            isArmed={snapshot.armedDeletionId === row.definitionId}
            isDeleting={snapshot.deletingId === row.definitionId}
            isAnyDeleteInFlight={snapshot.deletingId !== undefined}
            isOpenInEditor={
              snapshot.editorSubject?.kind === "stored" &&
              snapshot.editorSubject.definitionId === row.definitionId
            }
            refusal={snapshot.refusalByDefinitionId.get(row.definitionId)}
            view={view}
          />
        </li>
      ))}
    </ul>
  );
}
