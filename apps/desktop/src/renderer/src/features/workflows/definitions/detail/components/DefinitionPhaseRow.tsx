// One phase of a version body, in the sequence's own order. Optional members render only where
// the phase carries them. A `human` phase's `config` holds the question and answer schema, so
// the row previews that form with no submit control. A binding draws its scope reference beside
// the scope: two `project` bindings under different roots are different configured servers, and
// `user` carries no reference. The scope and reference are never joined into one string.

import type { McpServerBindingRef } from "@ai-sidekicks/contracts";

import { Chip } from "@renderer/components/Chip/Chip.js";
import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";
import type { WorkflowPhaseDefinition } from "@renderer/services/wire-shapes/workflow-definition-body.js";
import { schemaFormPreviewBody } from "../../../schema-form/schema-form-mounts.js";

/** The phase to draw. */
export interface DefinitionPhaseRowProps {
  readonly phase: WorkflowPhaseDefinition;
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
               * Narrowed on the union's discriminant, so a new arm without a reference stops
               * compiling here instead of rendering `undefined`.
               */}
              {toolBinding.binding.scope === "user" ? null : (
                <WireFigure value={toolBinding.binding.scopeRef} />
              )}
            </li>
          ))}
        </ul>
      )}
      {/*
       * Last in the row: it renders nothing for the four phase types that ask no question. It is
       * mounted through the schema form's loader-backed body, since the kit is its own chunk.
       */}
      {schemaFormPreviewBody.render({ phase })}
    </li>
  );
}

/**
 * One binding's full identity as a list key. Provider, server and tool alone collide for two
 * bindings differing in `scopeRef`. Serialized rather than delimiter-joined, since `scopeRef` is
 * a path and can contain any separator.
 */
function bindingRowKey(binding: McpServerBindingRef, toolName: string): string {
  const scopeRef = binding.scope === "user" ? undefined : binding.scopeRef;
  return JSON.stringify([binding.provider, binding.scope, scopeRef, binding.serverName, toolName]);
}
