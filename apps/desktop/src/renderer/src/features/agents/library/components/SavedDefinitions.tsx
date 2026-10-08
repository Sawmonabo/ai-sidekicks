import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { useAgesNow } from "#renderer/hooks/useAgesNow.js";
import { useClock } from "#renderer/services/platform/hooks/useClock.js";
import { type AgentLibrarySnapshot, type AgentLibraryView } from "../view.js";
import { NO_SAVED_DEFINITIONS, type AgentDefinitionRow } from "../definition-rows.js";
import { SavedDefinitionRow } from "./SavedDefinitionRow.js";

/** The saved column's three answers, one per arm of the reading. */
export function SavedDefinitions(props: {
  readonly snapshot: AgentLibrarySnapshot;
  readonly view: AgentLibraryView;
}): React.JSX.Element {
  const { snapshot, view } = props;
  const { reading } = snapshot;
  const nowMilliseconds = useAgesNow(
    useClock(),
    reading.kind === "rows" ? reading.rows.flatMap(instantReadings) : [],
  );
  if (reading.kind === "not-loaded") {
    return (
      <Nothing
        kind="not-loaded"
        placement="block"
        title="Reading the sidekicks saved on this node."
      />
    );
  }
  if (reading.kind === "empty") {
    return <Nothing kind="empty" placement="block" title={NO_SAVED_DEFINITIONS} />;
  }
  return (
    <>
      <ul className="meridian-agent-library__rows">
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
              nowMilliseconds={nowMilliseconds}
            />
          </li>
        ))}
      </ul>
    </>
  );
}

function instantReadings(row: AgentDefinitionRow): string[] {
  return row.axes.filter((axis) => axis.source === "instant").map((axis) => axis.reading);
}
