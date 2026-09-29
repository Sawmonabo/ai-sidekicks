import { Nothing } from "@renderer/console/primitives/index.js";
import { type AgentLibrarySnapshot, type AgentLibraryView } from "../library-view.js";
import { NO_SAVED_DEFINITIONS } from "../definition-rows.js";
import { SavedDefinitionRow } from "./SavedDefinitionRow.js";

/** The saved column's three answers, one per arm of the reading. */
export function SavedDefinitions(props: {
  readonly snapshot: AgentLibrarySnapshot;
  readonly view: AgentLibraryView;
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
  if (reading.kind === "empty") {
    return (
      <Nothing
        kind="empty"
        placement="surface"
        title={`${NO_SAVED_DEFINITIONS}.`}
        detail="Tuning one in a session and saving it puts it here, ready for the next session to start from."
      />
    );
  }
  return (
    <>
      <ul className="meridian-agent-definitions__rows">
        {reading.rows.map((row) => (
          <li key={row.definitionId}>
            <SavedDefinitionRow
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
    </>
  );
}
