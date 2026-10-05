// One leaf parameter drawn as the control its type calls for, with its label, help line and
// issue. A number keeps the typed text and a select stores the option's real value; turning
// either into what is sent is the check's job.

import type { WorkflowParamSpec, WorkflowParamType } from "@ai-sidekicks/contracts/workflow-kind";

/** What the form hands one leaf field. */
export interface ParamLeafFieldProps {
  readonly field: Exclude<WorkflowParamSpec, { type: "collection" }>;
  readonly answer: unknown;
  readonly onAnswerChange: (next: unknown) => void;
  /** The sentence the last check refused this answer with, if it did. */
  readonly issue: string | undefined;
  readonly isDisabled: boolean;
  /** The control's id; the help line and issue take it as their prefix. */
  readonly controlId: string;
}

/** A labeled control for one leaf parameter, its help under it and any issue below that. */
export function ParamLeafField(props: ParamLeafFieldProps): React.JSX.Element {
  const { field, issue, controlId } = props;
  const helpId = field.help === undefined ? undefined : `${controlId}-help`;
  const issueId = issue === undefined ? undefined : `${controlId}-issue`;
  const describedBy = [helpId, issueId].filter((id) => id !== undefined).join(" ") || undefined;
  const notes = (
    <>
      {field.help === undefined ? null : (
        <p id={helpId} className="meridian-workflow-param-form__help">
          {field.help}
        </p>
      )}
      {issue === undefined ? null : (
        <p id={issueId} className="meridian-workflow-param-form__issue">
          {issue}
        </p>
      )}
    </>
  );

  if (field.type === "multiselect") {
    return (
      <fieldset
        className="meridian-workflow-param-form__group"
        aria-describedby={describedBy}
        aria-invalid={issue === undefined ? undefined : true}
      >
        <legend className="meridian-workflow-param-form__legend">
          <FieldLabelText field={field} />
        </legend>
        <MultiselectChoices {...props} />
        {notes}
      </fieldset>
    );
  }

  if (field.type === "boolean") {
    return (
      <div className="meridian-workflow-param-form__field">
        <div className="meridian-workflow-param-form__choice">
          <input
            id={controlId}
            type="checkbox"
            checked={props.answer === true}
            disabled={props.isDisabled}
            aria-describedby={describedBy}
            aria-invalid={issue === undefined ? undefined : true}
            onChange={(event) => {
              props.onAnswerChange(event.target.checked);
            }}
          />
          <label htmlFor={controlId} className="meridian-workflow-param-form__label">
            <FieldLabelText field={field} />
          </label>
        </div>
        {notes}
      </div>
    );
  }

  if (field.type === "path") {
    // A path is never typed: it is picked through the platform's folder chooser, and no text box
    // stands in for that chooser.
    return (
      <div className="meridian-workflow-param-form__field">
        <span className="meridian-workflow-param-form__label">
          <FieldLabelText field={field} />
        </span>
        {notes}
      </div>
    );
  }

  return (
    <div className="meridian-workflow-param-form__field">
      <label htmlFor={controlId} className="meridian-workflow-param-form__label">
        <FieldLabelText field={field} />
      </label>
      <FieldControl {...props} describedBy={describedBy} />
      {notes}
    </div>
  );
}

// Long-form text, read as source, so the box is tall and resizable.
const TEXTAREA_TYPES: readonly WorkflowParamType[] = ["text", "json", "expression"];

// Typed as code or a machine string, so it is set in mono.
const MONO_TYPES: readonly WorkflowParamType[] = ["json", "expression", "glob", "cron"];

function FieldLabelText(props: {
  readonly field: ParamLeafFieldProps["field"];
}): React.JSX.Element {
  const isOptional = props.field.required !== true;
  return (
    <>
      {props.field.label}
      {isOptional ? (
        <span className="meridian-workflow-param-form__optional"> (optional)</span>
      ) : null}
    </>
  );
}

function FieldControl(
  props: ParamLeafFieldProps & { readonly describedBy: string | undefined },
): React.JSX.Element {
  const { field, controlId, describedBy } = props;
  const isInvalid = props.issue === undefined ? undefined : true;
  const className = MONO_TYPES.includes(field.type)
    ? "meridian-workflow-param-form__control meridian-workflow-param-form__control--mono"
    : "meridian-workflow-param-form__control";

  if (field.type === "select") {
    const options = field.options ?? [];
    const optionIndex = options.findIndex((option) => Object.is(option.value, props.answer));
    const isRequired = field.required === true;
    return (
      <select
        id={controlId}
        className={className}
        value={optionIndex === -1 ? "" : String(optionIndex)}
        disabled={props.isDisabled}
        aria-describedby={describedBy}
        aria-invalid={isInvalid}
        onChange={(event) => {
          const picked = event.target.value;
          props.onAnswerChange(picked === "" ? undefined : options[Number(picked)]?.value);
        }}
      >
        {/* A required select with nothing picked still shows the blank, so it never looks
            answered with its first option. */}
        {!isRequired || optionIndex === -1 ? (
          <option value="" disabled={isRequired}></option>
        ) : null}
        {options.map((option, index) => (
          <option key={index} value={String(index)}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }

  const text = readText(props.answer);
  if (TEXTAREA_TYPES.includes(field.type)) {
    return (
      <textarea
        id={controlId}
        className={className}
        value={text}
        rows={field.type === "text" ? 3 : 5}
        spellCheck={field.type === "text"}
        disabled={props.isDisabled}
        aria-describedby={describedBy}
        aria-invalid={isInvalid}
        onChange={(event) => {
          props.onAnswerChange(event.target.value);
        }}
      />
    );
  }

  return (
    <input
      id={controlId}
      className={className}
      type={field.type === "secret" ? "password" : "text"}
      inputMode={field.type === "number" ? "decimal" : undefined}
      autoComplete={field.type === "secret" ? "off" : undefined}
      spellCheck={field.type === "string" ? undefined : false}
      value={text}
      disabled={props.isDisabled}
      aria-describedby={describedBy}
      aria-invalid={isInvalid}
      onChange={(event) => {
        props.onAnswerChange(event.target.value);
      }}
    />
  );
}

function MultiselectChoices(props: ParamLeafFieldProps): React.JSX.Element {
  const options = props.field.options ?? [];
  const picked: readonly unknown[] = Array.isArray(props.answer) ? props.answer : [];
  const isPicked = (value: unknown): boolean => picked.some((each) => Object.is(each, value));
  return (
    <div className="meridian-workflow-param-form__choices">
      {options.map((option, index) => {
        const choiceId = `${props.controlId}-${index}`;
        return (
          <div key={choiceId} className="meridian-workflow-param-form__choice">
            <input
              id={choiceId}
              type="checkbox"
              checked={isPicked(option.value)}
              disabled={props.isDisabled}
              onChange={(event) => {
                // Kept in the options' order, whatever order they were ticked in.
                props.onAnswerChange(
                  options
                    .filter((each) =>
                      each === option ? event.target.checked : isPicked(each.value),
                    )
                    .map((each) => each.value),
                );
              }}
            />
            <label htmlFor={choiceId}>{option.label}</label>
          </div>
        );
      })}
    </div>
  );
}

function readText(answer: unknown): string {
  return typeof answer === "string" || typeof answer === "number" ? String(answer) : "";
}
