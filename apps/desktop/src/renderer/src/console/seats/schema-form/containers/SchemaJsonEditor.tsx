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
// AND "IT DID NOT" IS NOT THE SAME AS "NOT YET", NOR THE SAME AS "IT NEVER GOT HERE". The
// compiler arrives on its own chunk, so the validator has two further states this surface
// must not mistake for a refusal. While it reads `compiling` there is no verdict and no
// reason to give one, so the uncheckable sentence is withheld rather than shown and then
// retracted. Where the chunk failed to fetch there IS a sentence and it is the arm's own,
// never the reader's — the schema was never read, so nothing may be said about it. Both
// sentences land in the same paragraph because a person asking "will what I type be
// checked" gets one answer from either, and the difference between them is what the
// sentence says rather than where it sits. The syntax check above is unaffected by any of
// it — it needs nothing that has to be fetched.
//
// MONO, BECAUSE IT IS THE WIRE'S OWN SHAPE. What is typed here is the submitted value
// itself rather than prose about it, so it wears rule 4's provenance signature like every
// other wire figure on a console surface.
//
// NO EDITOR LIBRARY. `Spec-023 §Console Libraries` disqualifies every runtime-compiling
// schema editor before size is weighed, because this renderer's content policy carries no
// `unsafe-eval`. A textarea and one `JSON.parse` are the whole mechanism.
//
// AND THE EDITOR CARRIES ITS VERDICT THE WAY A DRAWN CONTROL CARRIES ITS OWN. Every drawn
// field attaches its findings through `aria-describedby` and renders them through
// `SchemaFieldIssues`; this surface listed them in markup of its own that nothing pointed
// at. Focus does not leave the textarea while somebody edits, so a reader whose document
// had just become invalid was told neither that it was invalid nor what the schema said —
// on the one arm of this form where the whole answer is typed into a single control. Same
// primitive, same attribute, and `aria-invalid` while either reading refuses: no second
// mechanism, and no `role` this list does not have where the drawn fields draw it.

import { useId } from "react";

import { SchemaFieldIssues } from "./SchemaFieldIssues.js";
import { describedByOf } from "./schema-field-control.js";
import type { SchemaFallback } from "../plan/schema-fields.js";
import { encodeMemberPointer, type SchemaValidationReport } from "../../../bridge/index.js";
import type { SchemaValidatorState } from "./schema-validator-arm.js";
import type { RawAnswerReading } from "./use-schema-form.js";

/** How tall the raw document opens. Layout only; the text is never bounded here. */
const RAW_EDITOR_ROWS = 12;

export interface SchemaJsonEditorProps {
  /** Why this schema is answered here rather than in drawn controls. */
  readonly fallback: SchemaFallback;
  readonly rawText: string;
  readonly onChangeRawText: (text: string) => void;
  readonly rawReading: RawAnswerReading;
  /**
   * Whether the schema itself could be checked against, the reason where not — and
   * whether that answer has arrived at all.
   */
  readonly validator: SchemaValidatorState;
  /** The schema's verdict, where there is a schema to have one and JSON to check. */
  readonly report: SchemaValidationReport | undefined;
}

/** The raw answer, its syntax, and — where the schema compiled — its validity. */
export function SchemaJsonEditor(props: SchemaJsonEditorProps): React.JSX.Element {
  const editorId = useId();
  const syntaxId = useId();
  const issuesId = useId();
  const { rawReading, report, validator } = props;
  const issues = rawIssueTexts(report);
  const isUnparsable = rawReading.status === "unparsable";
  const uncheckableDetail = uncheckableDetailOf(validator);
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
        // Both readings describe this one control, composed through the leaf the drawn
        // fields compose theirs through: unparsable text and a schema refusal are two
        // different complaints about the same document.
        aria-describedby={describedByOf([
          isUnparsable ? syntaxId : undefined,
          issues.length === 0 ? undefined : issuesId,
        ])}
        aria-invalid={isUnparsable || issues.length > 0 ? true : undefined}
        onChange={(event) => {
          props.onChangeRawText(event.currentTarget.value);
        }}
      />
      {isUnparsable ? (
        <p className="meridian-schema-raw__syntax" id={syntaxId} role="status">
          {rawReading.detail}
        </p>
      ) : null}
      {uncheckableDetail === undefined ? null : (
        <p className="meridian-schema-raw__uncheckable">{uncheckableDetail}</p>
      )}
      <SchemaFieldIssues issues={issues} issuesId={issuesId} />
    </div>
  );
}

/**
 * What the schema said about the typed document, each sentence carrying the member it is
 * about.
 *
 * The pointer rather than a join, for the reason the paths are segments at all: two
 * different members must not read as one line here either. Composed into text because
 * this arm draws no control per member — there is one control, and every finding on the
 * form is about what is in it.
 */
function rawIssueTexts(report: SchemaValidationReport | undefined): readonly string[] {
  if (report === undefined || report.status === "valid") {
    return [];
  }
  return report.issues.map((issue) => {
    const pointer = encodeMemberPointer(issue.memberPath);
    return pointer === "" ? issue.message : `${pointer}: ${issue.message}`;
  });
}

/**
 * The sentence about what will not be checked here, where the validator has one.
 *
 * A switch total over the arms rather than a comparison per arm, so a state added to
 * `SchemaValidatorState` decides here whether it has a sentence instead of silently
 * inheriting "no" — which is how the failed-fetch arm stayed unsaid on this surface.
 */
function uncheckableDetailOf(validator: SchemaValidatorState): string | undefined {
  switch (validator.status) {
    case "uncompilable":
    case "checker-unavailable":
      return validator.detail;
    case "compiling":
    case "compiled":
      return undefined;
  }
}
