// The form drawn from a kind's parameter list: a step waiting on a person shows it, and the
// builder's inspector reuses it. It holds no state; the answers and the last check's issues
// come from the caller, which seeds them and checks them with `param-answers.ts`.

import type { WorkflowParamSpec } from "@ai-sidekicks/contracts/workflow-kind";
import { isParamFieldShown, seedParamAnswers } from "./param-answers.js";
import type { ParamAnswers, ParamIssues } from "./param-answers.js";
import { ParamLeafField } from "./ParamLeafField.js";
import "./ParamForm.css";
import { ActionButton } from "../components/ActionButton.js";

/** What a mounted parameter form is handed. */
export interface ParamFormProps {
  readonly fields: readonly WorkflowParamSpec[];
  readonly answers: ParamAnswers;
  readonly onAnswersChange: (next: ParamAnswers) => void;
  /** Issues to show in place under each field, from the last check. */
  readonly issues: ParamIssues;
  readonly isDisabled?: boolean;
  /** Prefix for the ids tying labels and issue text to their controls; unique per mounted form. */
  readonly idPrefix: string;
}

/**
 * One labeled control per shown parameter, each drawn from the parameter's type. `answers` must
 * be what `seedParamAnswers` built for these fields, since a collection reads its nested shape.
 */
export function ParamForm(props: ParamFormProps): React.JSX.Element {
  return (
    <div className="meridian-workflow-param-form">
      <ParamFieldList
        fields={props.fields}
        answers={props.answers}
        onAnswersChange={props.onAnswersChange}
        issues={props.issues}
        isDisabled={props.isDisabled === true}
        idPrefix={props.idPrefix}
        pathPrefix=""
      />
    </div>
  );
}

/** One level of fields: the form's own, or a collection's for one entry. */
interface ParamFieldListProps {
  readonly fields: readonly WorkflowParamSpec[];
  readonly answers: ParamAnswers;
  readonly onAnswersChange: (next: ParamAnswers) => void;
  readonly issues: ParamIssues;
  readonly isDisabled: boolean;
  readonly idPrefix: string;
  /** The dotted path this level's field ids extend, empty at the top. */
  readonly pathPrefix: string;
}

function ParamFieldList(props: ParamFieldListProps): React.JSX.Element {
  return (
    <>
      {props.fields
        .filter((field) => isParamFieldShown(field, props.answers))
        .map((field) => {
          const path = `${props.pathPrefix}${field.id}`;
          const answer = props.answers[field.id];
          const changeAnswer = (next: unknown): void => {
            props.onAnswersChange({ ...props.answers, [field.id]: next });
          };
          return field.type === "collection" ? (
            <ParamCollectionField
              key={field.id}
              field={field}
              answer={answer}
              onAnswerChange={changeAnswer}
              issues={props.issues}
              isDisabled={props.isDisabled}
              idPrefix={props.idPrefix}
              path={path}
            />
          ) : (
            <ParamLeafField
              key={field.id}
              field={field}
              answer={answer}
              onAnswerChange={changeAnswer}
              issue={props.issues[path]}
              isDisabled={props.isDisabled}
              controlId={`${props.idPrefix}-${path}`}
            />
          );
        })}
    </>
  );
}

/** A collection's answer is the nested record `seedParamAnswers` built, or a list of them. */
interface ParamCollectionFieldProps {
  readonly field: Extract<WorkflowParamSpec, { type: "collection" }>;
  readonly answer: unknown;
  readonly onAnswerChange: (next: unknown) => void;
  readonly issues: ParamIssues;
  readonly isDisabled: boolean;
  readonly idPrefix: string;
  readonly path: string;
}

function ParamCollectionField(props: ParamCollectionFieldProps): React.JSX.Element {
  const { field } = props;
  if (field.multiple !== true) {
    return (
      <fieldset className="meridian-workflow-param-form__group">
        <legend className="meridian-workflow-param-form__legend">{field.label}</legend>
        <ParamFieldList
          fields={field.fields}
          answers={props.answer as ParamAnswers}
          onAnswersChange={props.onAnswerChange}
          issues={props.issues}
          isDisabled={props.isDisabled}
          idPrefix={props.idPrefix}
          pathPrefix={`${props.path}.`}
        />
      </fieldset>
    );
  }

  const entries = props.answer as readonly ParamAnswers[];
  return (
    <fieldset className="meridian-workflow-param-form__group">
      <legend className="meridian-workflow-param-form__legend">{field.label}</legend>
      {entries.length === 0 ? null : (
        <ol className="meridian-workflow-param-form__entries">
          {entries.map((entry, index) => (
            // Entries have no identity of their own, and every control in one is controlled,
            // so the position is the key.
            <li key={index}>
              <fieldset className="meridian-workflow-param-form__group">
                <legend className="meridian-workflow-param-form__legend">
                  {field.label} {index + 1}
                </legend>
                <ParamFieldList
                  fields={field.fields}
                  answers={entry}
                  onAnswersChange={(next) => {
                    props.onAnswerChange(entries.with(index, next));
                  }}
                  issues={props.issues}
                  isDisabled={props.isDisabled}
                  idPrefix={props.idPrefix}
                  pathPrefix={`${props.path}.${index}.`}
                />
                <ActionButton
                  className="meridian-workflow-param-form__entry-action"
                  aria-label={`Remove ${field.label} ${index + 1}`}
                  disabled={props.isDisabled}
                  onClick={() => {
                    props.onAnswerChange(entries.toSpliced(index, 1));
                  }}
                >
                  Remove
                </ActionButton>
              </fieldset>
            </li>
          ))}
        </ol>
      )}
      <ActionButton
        className="meridian-workflow-param-form__entry-action"
        aria-label={`Add ${field.label}`}
        disabled={props.isDisabled}
        onClick={() => {
          props.onAnswerChange([...entries, seedParamAnswers(field.fields)]);
        }}
      >
        Add
      </ActionButton>
    </fieldset>
  );
}
