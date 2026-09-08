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
//
// A `human` PHASE CARRIES A FORM AND THE ROW DRAWS IT. `config` is an open record on the
// wire, and for this one phase type it holds the question and the schema the answer is
// shaped by — so an author reading a definition can see the form the phase will ask
// instead of reading a JSON schema and imagining it. It is a reading of bytes this pane
// already has: no read is put, no run is reached, and no answer is sent, which is why the
// preview carries no submit control at all rather than a greyed one.
//
// A BINDING IS ITS SCOPE **AND** WHAT THAT SCOPE REFERS TO. `McpServerBindingRef` is a
// three-arm union rather than one shape because the reference is part of the binding's
// identity: two `project` bindings under different repository roots are two different
// configured servers wearing the same server and tool names, and a row printing only
// the broad scope word renders them identically — leaving nobody able to say which
// configured server the phase will invoke. So the reference is drawn beside the scope,
// wire-verbatim through the figure chokepoint, on the arms that carry one. The `user`
// arm carries none at all and nothing is drawn for it, rather than an empty figure
// standing where a path would be. That is `DefinitionDetail.tsx`'s own
// scope-and-reference pair one level down, and for its reason too: the two are never
// joined into one string, because a scope that refers to nothing narrower would read as
// a scope with a blank name.

import { Chip, WireFigure } from "../../../primitives/index.js";
import type { McpServerBindingRef, WorkflowPhaseDefinition } from "../../../bridge/index.js";
import { HumanPhaseFormPreview } from "../../forms/index.js";

export interface DefinitionPhaseRowProps {
  readonly phase: WorkflowPhaseDefinition;
}

/**
 * One binding's full identity, as a list key and never as anything a person reads.
 *
 * The server and tool names alone are not one: two bindings equal in provider, server
 * and tool and differing in `scopeRef` are two configured servers, and under a
 * name-only key they are two siblings React is told are the same element. Every member
 * the union declares goes in, so a collision needs two bindings that genuinely are one.
 *
 * SERIALIZED RATHER THAN DELIMITER-JOINED, because one of these members is a filesystem
 * path and can hold whichever separator a joined key would have picked — two bindings
 * whose parts straddle that separator differently would collide again, under one
 * repository root and not another.
 */
function bindingRowKey(binding: McpServerBindingRef, toolName: string): string {
  const scopeRef = binding.scope === "user" ? undefined : binding.scopeRef;
  return JSON.stringify([binding.provider, binding.scope, scopeRef, binding.serverName, toolName]);
}

/** One phase row: its name, its closed vocabulary values, and its tool bindings. */
export function DefinitionPhaseRow(props: DefinitionPhaseRowProps): React.JSX.Element {
  const { phase } = props;
  const toolBindings = phase.toolBindings ?? [];
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
      {toolBindings.length === 0 ? null : (
        <ul className="meridian-definition-detail__bindings">
          {toolBindings.map((toolBinding) => (
            <li key={bindingRowKey(toolBinding.binding, toolBinding.toolName)}>
              <WireFigure value={`${toolBinding.binding.serverName}/${toolBinding.toolName}`} />
              <Chip mono label={toolBinding.binding.provider} />
              <Chip mono label={toolBinding.binding.scope} />
              {/*
               * Narrowed on the union's own discriminant rather than on the member being
               * present: `user` is the one arm declared without a reference, so a fourth
               * arm added without one stops compiling here instead of rendering
               * `undefined` where a scope's identity belongs.
               */}
              {toolBinding.binding.scope === "user" ? null : (
                <WireFigure value={toolBinding.binding.scopeRef} />
              )}
            </li>
          ))}
        </ul>
      )}
      {/*
       * Last in the row, because it is the phase's own detail rather than one of its
       * closed vocabulary values, and it renders nothing at all for the four phase types
       * that ask no question — which is what keeps the row a row for every other phase.
       */}
      <HumanPhaseFormPreview phase={phase} />
    </li>
  );
}
