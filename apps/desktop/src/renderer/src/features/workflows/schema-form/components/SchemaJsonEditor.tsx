// The answer as JSON, for a schema this form cannot draw controls for. The mapper's reason
// stands above it, so no phase is unanswerable. Syntax is always checked; the schema check
// runs only where the schema compiled, else the editor says what will not be checked (nothing
// while `compiling`). A textarea and `JSON.parse`: the content policy has no `unsafe-eval`.
// Findings attach through `aria-describedby` as on drawn fields, since focus stays here.

import { useId } from "react";

import { SchemaFieldIssues } from "./SchemaFieldIssues.js";
import { describedByOf } from "./field-control-props.js";
import type { SchemaFallback } from "../plan/schema-fields.js";
import { encodeMemberPointer } from "../schema-member-path.js";
import { type SchemaValidationReport } from "../json-schema-validator.js";
import type { SchemaValidatorState } from "../schema-validator-state.js";
import type { RawAnswerReading } from "../hooks/useSchemaForm.js";

/** How tall the raw document opens. Layout only; the text is never bounded here. */
const RAW_EDITOR_ROWS = 12;

/** The props of the raw JSON answer editor. */
export interface SchemaJsonEditorProps {
  /** Why this schema is answered here rather than in drawn controls. */
  readonly fallback: SchemaFallback;
  readonly rawText: string;
  readonly onChangeRawText: (text: string) => void;
  readonly rawReading: RawAnswerReading;
  /** Whether the schema could be checked against, and the reason where not. */
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
        // Both readings describe this one control.
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
 * What the schema said about the typed document, each sentence prefixed with the pointer of
 * the member it is about: this arm has one control, so findings are composed into text.
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
 * The sentence about what will not be checked here, where the validator has one. The switch
 * is total, so a new validator state must decide whether it has a sentence.
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
