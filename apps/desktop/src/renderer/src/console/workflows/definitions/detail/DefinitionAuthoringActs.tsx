// The three acts a definition's detail offers, and what each of them settled to.
//
// OFFERED AND NEVER GREYED. Whether this caller may write at a scope is the daemon's
// adjudication, and nothing here pre-empts it: every control is pressable and the
// answer — the port's `wire-unregistered`, a daemon's typed code, a parse's reason —
// renders under the control that asked. That is rule 9 applied to an act rather than
// to a read, and it is also the only honest shape while the create is on the growth
// port: a console that disabled the controls would be asserting an eligibility nobody
// asked about.
//
// THE PASTE BOX IS PART OF THE IMPORT ACT AND NOT A SEPARATE SURFACE. An import needs
// bytes, this build has no file-open wire, and a modal for one textarea would be a
// window between a person and a control they had already pressed. So the box is
// revealed by the act and collapses when it settles.
//
// THE EXPORT'S BYTES STAY ON SCREEN AFTER THE COPY. The host may refuse the clipboard,
// and a person left with a settled control and nothing to select would have to press it
// again to find out. The file is rendered read-only either way, and the refusal — if
// there was one — renders beside it.

import { useId, useState } from "react";

import { ActOutcomeRow } from "./ActOutcomeRow.js";
import {
  WORKFLOW_DETAIL_ACTS,
  type WorkflowDefinitionAuthoring,
  type WorkflowDetailAct,
} from "./definition-authoring.js";

/** What each act is called on its own control. One record, so no literal is loose. */
const ACT_LABEL: Readonly<Record<WorkflowDetailAct, string>> = {
  export: "Export",
  import: "Import",
  promote: "Promote to shared",
};

export interface DefinitionAuthoringActsProps {
  readonly authoring: WorkflowDefinitionAuthoring;
}

/** The detail's act strip: three controls, each rendering its own last answer. */
export function DefinitionAuthoringActs(props: DefinitionAuthoringActsProps): React.JSX.Element {
  const { authoring } = props;
  const [pastedFile, setPastedFile] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  // Generated rather than fixed: two builder panes can stand in one deck, and a
  // hardcoded id would give the second one's label a control belonging to the first.
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
        <button
          type="button"
          className="meridian-definition-detail__act"
          onClick={() => {
            authoring.promoteDefinition();
          }}
        >
          {ACT_LABEL.promote}
        </button>
      </div>
      {importOpen ? (
        <form
          className="meridian-definition-detail__import"
          onSubmit={(submission) => {
            // The default would navigate the renderer's own document, which for a
            // custom-scheme bundle is a reload of the whole console.
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
         * Iterated over the closed TUPLE rather than over the record's own entries, so
         * the order is the one the acts are declared in and no cast is needed to get a
         * key back out of `Object.entries`, which types one as a bare string.
         */}
        {WORKFLOW_DETAIL_ACTS.map((act) => (
          <ActOutcomeRow key={act} label={ACT_LABEL[act]} outcome={authoring.outcomes[act]} />
        ))}
      </ul>
    </section>
  );
}
