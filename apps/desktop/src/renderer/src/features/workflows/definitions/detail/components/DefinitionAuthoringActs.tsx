// The two acts a definition's detail offers, and what each settled to. Controls are never
// grayed: whether a caller may write at a scope is the daemon's adjudication, and the answer
// renders under the control that asked. The paste box belongs to the import act (this build has
// no file-open wire). The export's bytes stay on screen after the copy, since the host may refuse
// the clipboard.

import { useId, useState } from "react";

import { ActOutcomeRow } from "./ActOutcomeRow.js";
import {
  WORKFLOW_DETAIL_ACTS,
  type WorkflowDefinitionAuthoring,
  type WorkflowDetailAct,
} from "../definition-authoring.js";

/** What each act is called on its own control. One record, so no literal is loose. */
const ACT_LABEL: Readonly<Record<WorkflowDetailAct, string>> = {
  export: "Export",
  import: "Import",
};

/** The authoring state and presses the act strip renders and forwards. */
export interface DefinitionAuthoringActsProps {
  readonly authoring: WorkflowDefinitionAuthoring;
}

/** The detail's act strip: two controls, each rendering its own last answer. */
export function DefinitionAuthoringActs(props: DefinitionAuthoringActsProps): React.JSX.Element {
  const { authoring } = props;
  const [pastedFile, setPastedFile] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  // Generated: two builder panes can stand in one layout, and a fixed id would cross their labels.
  const pasteBoxId = useId();
  return (
    <section className="meridian-definition-detail__acts">
      <h4 className="meridian-definition-detail__heading">Acts</h4>
      <div className="meridian-definition-detail__act-row">
        <button
          type="button"
          className="meridian-definition-detail__act"
          onClick={() => {
            authoring.exportDefinition();
          }}
        >
          {ACT_LABEL.export}
        </button>
        <button
          type="button"
          className="meridian-definition-detail__act"
          onClick={() => {
            setImportOpen(true);
          }}
        >
          {ACT_LABEL.import}
        </button>
      </div>
      {importOpen ? (
        <form
          className="meridian-definition-detail__import"
          onSubmit={(submission) => {
            // The default would navigate the renderer's own document, reloading the console.
            submission.preventDefault();
            authoring.importDefinition(pastedFile);
          }}
        >
          <label className="meridian-definition-detail__import-label" htmlFor={pasteBoxId}>
            Paste a definition file
          </label>
          <textarea
            id={pasteBoxId}
            className="meridian-definition-detail__import-box"
            value={pastedFile}
            spellCheck={false}
            rows={6}
            onChange={(change) => {
              setPastedFile(change.target.value);
            }}
          />
          <div className="meridian-definition-detail__act-row">
            <button type="submit" className="meridian-definition-detail__act">
              Submit
            </button>
            <button
              type="button"
              className="meridian-definition-detail__act"
              onClick={() => {
                setImportOpen(false);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}
      {authoring.exportedFile !== undefined ? (
        <textarea
          className="meridian-definition-detail__file"
          readOnly
          rows={8}
          aria-label="The exported definition file"
          value={authoring.exportedFile}
        />
      ) : null}
      <ul className="meridian-definition-detail__outcomes">
        {/*
         * Iterated over the closed tuple so the order is declaration order and no cast is needed
         * to recover a key type from `Object.entries`.
         */}
        {WORKFLOW_DETAIL_ACTS.map((act) => (
          <ActOutcomeRow key={act} label={ACT_LABEL[act]} outcome={authoring.outcomes[act]} />
        ))}
      </ul>
    </section>
  );
}
