// A tool server's elicitation form as the questions card asks it: each field the form names is one
// question, in the form's own order, carrying whether the form requires it, the answer it starts
// from and a number field's bounds; the answers go back keyed by field, each as the type the field
// declares.

import type {
  QuestionAnswer,
  QuestionDefault,
  QuestionPrompt,
} from "@ai-sidekicks/contracts/question";

import { isPlainObject, readNonEmptyString } from "../../../record-readers.js";
import { readQuestionAnswerTexts } from "../../question-answers.js";
import {
  type CodexAskOptionSetReading,
  readCodexElicitationFieldOptionSet,
} from "../ask-option-sets.js";

interface CodexElicitationField {
  readonly name: string;
  readonly property: Readonly<Record<string, unknown>>;
  readonly takesSeveralAnswers: boolean;
  readonly isRequired: boolean;
}

/**
 * The questions one `mcpServer/elicitation/request` asks: one per field of a `form` with fields,
 * else its message alone. Every field carries the server's name and its message.
 */
export function readCodexElicitationQuestions(params: unknown): QuestionPrompt[] {
  const payload = isPlainObject(params) ? params : {};
  const message = readNonEmptyString(payload, "message");
  const serverName = readNonEmptyString(payload, "serverName");
  const header = serverName === undefined ? {} : { header: serverName };
  const fields = readCodexElicitationFields(payload);
  if (fields.length === 0) {
    return message === undefined
      ? []
      : [{ ...header, text: message, options: [], severalAnswers: false, secret: false }];
  }
  return fields.map((field) => {
    const optionSet = readCodexElicitationFieldOptionSet(field.property, field.takesSeveralAnswers);
    const startingAnswer = readStartingAnswer(field, optionSet);
    const { minimum, maximum } = readNumberRange(field.property);
    return {
      ...header,
      ...(message === undefined ? {} : { heading: message }),
      text:
        readNonEmptyString(field.property, "title") ??
        readNonEmptyString(field.property, "description") ??
        field.name,
      options:
        optionSet.kind === "read"
          ? optionSet.options.map((option) => ({ label: option.label }))
          : [],
      severalAnswers: field.takesSeveralAnswers,
      secret: false,
      required: field.isRequired,
      ...(startingAnswer === undefined ? {} : { default: startingAnswer }),
      ...(minimum === undefined ? {} : { minimum }),
      ...(maximum === undefined ? {} : { maximum }),
    };
  });
}

/**
 * The answer a field starts from: an option field's preselected value as its option's label, a
 * typed field's value as declared. None where the form declares none, or one the card could not
 * draw, such as a value that is no option of the field.
 */
function readStartingAnswer(
  field: CodexElicitationField,
  optionSet: CodexAskOptionSetReading,
): QuestionDefault | undefined {
  const declared = field.property["default"];
  if (declared === undefined) {
    return undefined;
  }
  if (optionSet.kind === "read") {
    const values = Array.isArray(declared) ? declared : [declared];
    const labels = values.map(
      (value) => optionSet.options.find((option) => option.value === value)?.label,
    );
    if (labels.some((label) => label === undefined)) {
      return undefined;
    }
    const known = labels as string[];
    return field.takesSeveralAnswers ? known : known[0];
  }
  if (Array.isArray(declared)) {
    return declared.every((value) => typeof value === "string" && value.length > 0)
      ? (declared as string[])
      : undefined;
  }
  if (typeof declared === "string" || typeof declared === "boolean") {
    return declared;
  }
  return typeof declared === "number" && Number.isFinite(declared) ? declared : undefined;
}

// A number field's bounds, where the form sets finite ones. Bounds that cross bound no number, so
// both are dropped and the field asks unbounded rather than the whole card failing.
function readNumberRange(property: Readonly<Record<string, unknown>>): {
  readonly minimum: number | undefined;
  readonly maximum: number | undefined;
} {
  const minimum = readNumberBound(property, "minimum");
  const maximum = readNumberBound(property, "maximum");
  return minimum !== undefined && maximum !== undefined && minimum > maximum
    ? { minimum: undefined, maximum: undefined }
    : { minimum, maximum };
}

// A number field's bound, where the form sets a finite one.
function readNumberBound(
  property: Readonly<Record<string, unknown>>,
  bound: "minimum" | "maximum",
): number | undefined {
  if (property["type"] !== "number" && property["type"] !== "integer") {
    return undefined;
  }
  const value = property[bound];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * The form's `content`: each answered field under its own name, a picked label as the value it
 * stands for and typed text as the field's own type. `answers` holds one per question, in the
 * order {@link readCodexElicitationQuestions} asked them; a skipped one leaves the field out.
 */
export function composeCodexElicitationContent(
  params: unknown,
  answers: readonly QuestionAnswer[],
): Record<string, unknown> {
  const content: Record<string, unknown> = {};
  readCodexElicitationFields(isPlainObject(params) ? params : {}).forEach((field, index) => {
    const picks = readQuestionAnswerTexts(answers[index]);
    if (picks.length === 0) {
      return;
    }
    const optionSet = readCodexElicitationFieldOptionSet(field.property, field.takesSeveralAnswers);
    const values = picks.map((pick) =>
      optionSet.kind === "read"
        ? (optionSet.options.find((option) => option.label === pick)?.value ?? pick)
        : readTypedAnswer(field.property, pick),
    );
    content[field.name] = field.takesSeveralAnswers ? values : values[0];
  });
  return content;
}

// The fields of a `form` elicitation, in the order its schema names them; none for any other mode.
function readCodexElicitationFields(
  payload: Readonly<Record<string, unknown>>,
): CodexElicitationField[] {
  const schema = payload["mode"] === "form" ? payload["requestedSchema"] : undefined;
  if (!isPlainObject(schema) || !isPlainObject(schema["properties"])) {
    return [];
  }
  const requiredNames = Array.isArray(schema["required"]) ? schema["required"] : [];
  return Object.entries(schema["properties"]).flatMap(([name, property]) =>
    isPlainObject(property)
      ? [
          {
            name,
            property,
            takesSeveralAnswers: property["type"] === "array",
            isRequired: requiredNames.includes(name),
          },
        ]
      : [],
  );
}

// Typed text as the type the field declares; text that is no such value goes as typed, for the
// server to refuse.
function readTypedAnswer(property: Readonly<Record<string, unknown>>, text: string): unknown {
  switch (property["type"]) {
    case "number":
    case "integer": {
      const value = Number(text);
      return text.trim() === "" || !Number.isFinite(value) ? text : value;
    }
    case "boolean":
      return text === "true" ? true : text === "false" ? false : text;
    default:
      return text;
  }
}
