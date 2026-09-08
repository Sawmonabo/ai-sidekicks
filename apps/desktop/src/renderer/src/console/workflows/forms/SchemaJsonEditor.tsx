// The answer as JSON, for a schema this form cannot draw controls for.
//
// THIS IS WHY NO PHASE IS UNANSWERABLE. A schema outside the drawn render set is not a
// refusal and never renders as one: it opens here, with the schema's own reason stated
// above it, and the answer is typed as the object the phase asked for. A form that
// refused an unusual schema would leave a run parked on a question nobody could answer.
//
// TWO CHECKS, AND THEY ARE NOT THE SAME CHECK. The first is whether the text is JSON at
// all, which is always available. The second is whether the JSON satisfies the phase's
// schema, which is available only where that schema compiled — and where it did not, this
// surface says so rather than showing a green tick that means less than it looks like.
//
// MONO, BECAUSE IT IS THE WIRE'S OWN SHAPE. What is typed here is the submitted value
// itself rather than prose about it, so it wears rule 4's provenance signature like every
// other wire figure on a console surface.
//
// NO EDITOR LIBRARY. `Spec-023 §Console Libraries` disqualifies every runtime-compiling
// schema editor before size is weighed, because this renderer's content policy carries no
// `unsafe-eval`. A textarea and one `JSON.parse` are the whole mechanism.

import { useId } from "react";

import type { SchemaFallback } from "./schema-fields.js";
import type { SchemaValidationReport, SchemaValidator } from "../../bridge/index.js";
import type { RawAnswerReading } from "./use-schema-form.js";

/** How tall the raw document opens. Layout only; the text is never bounded here. */
const RAW_EDITOR_ROWS = 12;

export interface SchemaJsonEditorProps {
  /** Why this schema is answered here rather than in drawn controls. */
  readonly fallback: SchemaFallback;
  readonly rawText: string;
  readonly onChangeRawText: (text: string) => void;
  readonly rawReading: RawAnswerReading;
  /** Whether the schema itself could be checked against, and the reason where not. */
  readonly validator: SchemaValidator;
  /** The schema's verdict, where there is a schema to have one and JSON to check. */
  readonly report: SchemaValidationReport | undefined;
}

/** The raw answer, its syntax, and — where the schema compiled — its validity. */
export function SchemaJsonEditor(props: SchemaJsonEditorProps): React.JSX.Element {
  const editorId = useId();
  const { rawReading, report, validator } = props;
  return (
    <div className="meridian-schema-raw">
      <p className="meridian-schema-raw__reason">{props.fallback.detail}</p>
      <label className="meridian-schema-field__label" htmlFor={editorId}>
        The answer, as JSON
      </label>
      <textarea
        id={editorId}
        className="meridian-schema-raw__editor"
        rows={RAW_EDITOR_ROWS}
        spellCheck={false}
        value={props.rawText}
        onChange={(event) => {
          props.onChangeRawText(event.currentTarget.value);
        }}
      />
      {rawReading.status === "unparsable" ? (
        <p className="meridian-schema-raw__syntax" role="status">
          {rawReading.detail}
        </p>
      ) : null}
      {validator.status === "uncompilable" ? (
        <p className="meridian-schema-raw__uncheckable">{validator.detail}</p>
      ) : null}
      {report === undefined || report.status === "valid" ? null : (
        <ul className="meridian-schema-field__issues">
          {report.issues.map((issue) => (
            <li key={`${issue.memberPath}:${issue.message}`}>
              {issue.memberPath === "" ? issue.message : `${issue.memberPath}: ${issue.message}`}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
