// One phase of a version body, in the sequence's own order.
//
// ITS OWN MODULE BECAUSE EVERY `.tsx` HOLDS ONE COMPONENT — the package rule, checked
// by the architecture tier rather than left to review. It is reached from the list in
// `DefinitionVersionBody.tsx` and from nothing else, which makes it a deep sibling
// import and not a name on any door.
//
// THE THREE CLOSED MEMBERS ARE CHIPS because each is a value from a vocabulary the wire
// declares, and the two optional ones are rendered only where the phase carries them —
// a phase with no `goBackTo` has no target, and an empty label saying so would be the
// renderer inventing a fact about the definition.

import { Chip, WireFigure } from "../../../primitives/index.js";
import type { WorkflowPhaseDefinition } from "../../../bridge/index.js";

export interface DefinitionPhaseRowProps {
  readonly phase: WorkflowPhaseDefinition;
}

/** One phase row: its name, its closed vocabulary values, and its tool bindings. */
export function DefinitionPhaseRow(props: DefinitionPhaseRowProps): React.JSX.Element {
  const { phase } = props;
  const bindings = phase.toolBindings ?? [];
  return (
    <li className="meridian-definition-detail__phase">
      <span className="meridian-definition-detail__phase-name">{phase.name}</span>
      <Chip mono label={phase.type} />
      <Chip mono label={phase.gateType} />
      <span className="meridian-definition-detail__phase-failure">
        on failure <Chip mono label={phase.failureBehavior} />
        {phase.goBackTo === undefined ? null : (
          <>
            {" to "}
            <WireFigure value={phase.goBackTo} />
          </>
        )}
      </span>
      {phase.parallelJoinPolicy === undefined ? null : (
        <span className="meridian-definition-detail__phase-join">
          join <Chip mono label={phase.parallelJoinPolicy} />
        </span>
      )}
      {bindings.length === 0 ? null : (
        <ul className="meridian-definition-detail__bindings">
          {bindings.map((binding) => (
            <li key={`${binding.binding.serverName}/${binding.toolName}`}>
              <WireFigure value={`${binding.binding.serverName}/${binding.toolName}`} />
              <Chip mono label={binding.binding.provider} />
              <Chip mono label={binding.binding.scope} />
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
