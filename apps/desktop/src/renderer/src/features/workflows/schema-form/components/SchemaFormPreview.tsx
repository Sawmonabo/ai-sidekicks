// The definition-side preview of what a human phase will ask, drawn live from the schema the
// author is reading. It sends nothing (there is no run to submit against), so it has no submit
// control, and it refuses on a root no submission can carry (`schema-root-shape.ts`) as the
// run's form does.

import { SchemaForm } from "./SchemaForm.js";
import { humanPhaseFormConfigOf } from "../human-phase-config.js";
import { schemaRootRefusal } from "../plan/schema-root-shape.js";
import { useSchemaForm } from "../hooks/useSchemaForm.js";
import type { WorkflowPhaseDefinition } from "@renderer/services/wire-shapes/workflow-definition-body.js";
import { InlineRefusal } from "@renderer/components/Refusal/InlineRefusal.js";

/** The props of a phase's form preview. */
export interface SchemaFormPreviewProps {
  readonly phase: WorkflowPhaseDefinition;
}

/** The form this phase will ask, or nothing at all where it asks for none. */
export function SchemaFormPreview(props: SchemaFormPreviewProps): React.ReactNode {
  const config = humanPhaseFormConfigOf(props.phase);
  // Called unconditionally: a hook may not sit behind a branch. A phase with no form passes
  // `undefined`, which the mapper resolves to the raw arm.
  const form = useSchemaForm(config?.inputSchema);
  if (config === undefined) {
    return null;
  }
  const rootRefusal = schemaRootRefusal(config.inputSchema);
  return (
    <div className="meridian-schema-preview">
      <p className="meridian-schema-preview__caption">
        What this phase asks. Answering it here changes nothing — the phase is answered from its
        run.
      </p>
      {config.prompt === undefined ? null : (
        <p className="meridian-schema-preview__prompt">{config.prompt}</p>
      )}
      {rootRefusal === undefined ? (
        <SchemaForm form={form} />
      ) : (
        <InlineRefusal code={rootRefusal.code} detail={rootRefusal.detail} />
      )}
    </div>
  );
}
