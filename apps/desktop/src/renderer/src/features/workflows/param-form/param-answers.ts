// The answers a form drawn from a kind's parameter list holds, and the check that decides
// whether they may be sent. The form keeps what the person typed (a number field holds its
// text, a JSON field its source), so the check is where text becomes the value that is sent.

import type { WorkflowParamSpec } from "@ai-sidekicks/contracts/workflow/kind";
import type { WorkflowHumanFormPathAnswer } from "@ai-sidekicks/contracts/workflow/run/step";

/** The answers a form holds, keyed by field id. */
export type ParamAnswers = Readonly<Record<string, unknown>>;

/** One sentence per field id that holds an answer the form refuses. */
export type ParamIssues = Readonly<Record<string, string>>;

/** What checking a form's answers found. */
export type ParamAnswerCheck =
  | {
      readonly kind: "valid";
      readonly values: Record<string, unknown>;
      /** Each answered `path` field, by its dotted place, carried beside `values`, never in it. */
      readonly paths: WorkflowHumanFormPathAnswer[];
    }
  | { readonly kind: "invalid"; readonly issues: ParamIssues };

/**
 * The answers a form opens with: the saved answer where `saved` holds the field's id, else the
 * field's default in the form the control edits, else the control's empty answer. A collection
 * seeds a nested record, or a list of them when it repeats.
 */
export function seedParamAnswers(
  fields: readonly WorkflowParamSpec[],
  saved?: Readonly<Record<string, unknown>>,
): ParamAnswers {
  const answers: Record<string, unknown> = {};
  for (const field of fields) {
    const hasSaved = saved !== undefined && Object.hasOwn(saved, field.id);
    const savedAnswer = hasSaved ? saved[field.id] : undefined;
    if (field.type === "collection") {
      answers[field.id] = seedCollection(field, savedAnswer);
    } else if (hasSaved) {
      answers[field.id] = savedAnswer;
    } else if (field.default !== undefined) {
      answers[field.id] = seedFromDefault(field, field.default);
    } else {
      answers[field.id] = emptyAnswer(field.type);
    }
  }
  return answers;
}

/**
 * Whether a field is drawn: always, unless its `showWhen` names siblings, in which case each
 * named sibling's answer, read as it would be sent (a number field's text as its number), must
 * be one of the values listed for it. `siblings` is the field list `field` belongs to.
 */
export function isParamFieldShown(
  field: WorkflowParamSpec,
  answers: ParamAnswers,
  siblings: readonly WorkflowParamSpec[],
): boolean {
  if (field.type === "collection" || field.showWhen === undefined) {
    return true;
  }
  return Object.entries(field.showWhen).every(([siblingId, listedValues]) => {
    const sentAnswer = sentValueOf(
      siblings.find((sibling) => sibling.id === siblingId),
      answers[siblingId],
    );
    return listedValues.some((listedValue) => Object.is(listedValue, sentAnswer));
  });
}

/**
 * Checks every shown field's answer. Valid answers carry the values to send, with empty
 * optional fields and hidden fields left out, and each `path` field's picked token apart in
 * `paths`; otherwise one sentence per refused field. Both are keyed by the field's dotted place
 * (`parent.child`, or `parent.0.child` inside a repeating collection).
 */
export function checkParamAnswers(
  fields: readonly WorkflowParamSpec[],
  answers: ParamAnswers,
): ParamAnswerCheck {
  const found: FoundAnswers = { issues: {}, paths: [] };
  const values = checkFieldList(fields, answers, "", found);
  return Object.keys(found.issues).length === 0
    ? { kind: "valid", values, paths: found.paths }
    : { kind: "invalid", issues: found.issues };
}

/**
 * The answers as a draft may keep them: every answer but a secret's and a path's, at every depth.
 * A secret typed into a form never leaves the window until the form is sent, and a path's answer
 * is a folder token that holds only for the page that picked it.
 */
export function draftParamAnswers(
  fields: readonly WorkflowParamSpec[],
  answers: ParamAnswers,
): ParamAnswers {
  const draft: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.type === "secret" || field.type === "path" || !Object.hasOwn(answers, field.id)) {
      continue;
    }
    const answer = answers[field.id];
    if (field.type !== "collection") {
      draft[field.id] = answer;
    } else if (Array.isArray(answer)) {
      draft[field.id] = answer.map((entry) =>
        draftParamAnswers(field.fields, readRecord(entry) ?? {}),
      );
    } else {
      draft[field.id] = draftParamAnswers(field.fields, readRecord(answer) ?? {});
    }
  }
  return draft;
}

type LeafParamSpec = Exclude<WorkflowParamSpec, { type: "collection" }>;

type CollectionParamSpec = Extract<WorkflowParamSpec, { type: "collection" }>;

/** What a check gathers beside the values: the refusals and the `path` fields' answers. */
interface FoundAnswers {
  readonly issues: Record<string, string>;
  readonly paths: WorkflowHumanFormPathAnswer[];
}

/** One leaf field's answer once checked. */
type LeafOutcome =
  | { readonly kind: "answered"; readonly value: unknown }
  | { readonly kind: "empty" }
  | { readonly kind: "refused"; readonly issue: string };

function seedCollection(field: CollectionParamSpec, savedAnswer: unknown): unknown {
  if (field.multiple === true) {
    return Array.isArray(savedAnswer)
      ? savedAnswer.map((entry) => seedParamAnswers(field.fields, readRecord(entry)))
      : [];
  }
  return seedParamAnswers(field.fields, readRecord(savedAnswer));
}

// A number field edits text and a JSON field edits source, so their defaults open as text.
function seedFromDefault(field: LeafParamSpec, defaultValue: unknown): unknown {
  if (field.type === "number" && typeof defaultValue === "number") {
    return String(defaultValue);
  }
  if (field.type === "json" && typeof defaultValue !== "string") {
    return JSON.stringify(defaultValue, null, 2);
  }
  return defaultValue;
}

function emptyAnswer(type: LeafParamSpec["type"]): unknown {
  switch (type) {
    case "boolean":
      return false;
    case "multiselect":
      return [];
    case "number":
    case "select":
      return undefined;
    default:
      return "";
  }
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function checkFieldList(
  fields: readonly WorkflowParamSpec[],
  answers: ParamAnswers,
  pathPrefix: string,
  found: FoundAnswers,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of fields) {
    if (!isParamFieldShown(field, answers, fields)) {
      continue;
    }
    const place = `${pathPrefix}${field.id}`;
    const answer = answers[field.id];
    if (field.type === "collection") {
      values[field.id] = checkCollection(field, answer, place, found);
      continue;
    }
    const outcome = checkLeaf(field, answer);
    if (outcome.kind === "refused") {
      found.issues[place] = outcome.issue;
    } else if (outcome.kind === "answered" && field.type === "path") {
      // The picker's token, which main swaps for the path at this one member.
      found.paths.push({ field: place, path: String(outcome.value) });
    } else if (outcome.kind === "answered") {
      values[field.id] = outcome.value;
    }
  }
  return values;
}

function checkCollection(
  field: CollectionParamSpec,
  answer: unknown,
  place: string,
  found: FoundAnswers,
): unknown {
  if (field.multiple === true) {
    const entries: readonly unknown[] = Array.isArray(answer) ? answer : [];
    return entries.map((entry, index) =>
      checkFieldList(field.fields, readRecord(entry) ?? {}, `${place}.${index}.`, found),
    );
  }
  return checkFieldList(field.fields, readRecord(answer) ?? {}, `${place}.`, found);
}

// No sentence echoes the answer, so a secret never reaches an issue.
function checkLeaf(field: LeafParamSpec, answer: unknown): LeafOutcome {
  if (isEmptyAnswer(answer)) {
    return field.required === true
      ? { kind: "refused", issue: "This field is required." }
      : { kind: "empty" };
  }
  switch (field.type) {
    case "number":
      return readNumber(answer);
    case "select":
      return isListedOption(field, answer)
        ? { kind: "answered", value: answer }
        : { kind: "refused", issue: "Choose one of the listed options." };
    case "multiselect":
      return Array.isArray(answer) && answer.every((value) => isListedOption(field, value))
        ? { kind: "answered", value: answer }
        : { kind: "refused", issue: "Choose only from the listed options." };
    case "json":
      return readJson(answer);
    default:
      return { kind: "answered", value: answer };
  }
}

// What a sibling's answer is sent as, which a `showWhen` list is written against; an answer the
// check refuses, or a field the list does not hold, compares as it was typed.
function sentValueOf(sibling: WorkflowParamSpec | undefined, answer: unknown): unknown {
  if (sibling === undefined || sibling.type === "collection") {
    return answer;
  }
  const outcome = checkLeaf(sibling, answer);
  return outcome.kind === "answered" ? outcome.value : answer;
}

// A checkbox's `false` is an answer, not an empty one.
function isEmptyAnswer(answer: unknown): boolean {
  if (answer === undefined || answer === null) {
    return true;
  }
  if (typeof answer === "string") {
    return answer.trim() === "";
  }
  return Array.isArray(answer) && answer.length === 0;
}

function readNumber(answer: unknown): LeafOutcome {
  const parsed =
    typeof answer === "number"
      ? answer
      : typeof answer === "string"
        ? Number(answer.trim())
        : Number.NaN;
  return Number.isFinite(parsed)
    ? { kind: "answered", value: parsed }
    : { kind: "refused", issue: "Enter a number." };
}

function isListedOption(field: LeafParamSpec, value: unknown): boolean {
  return field.options?.some((option) => Object.is(option.value, value)) === true;
}

// A saved draft may already hold the parsed value; typed source is parsed here, and a refusal
// keeps the parser's own words for where the text went wrong.
function readJson(answer: unknown): LeafOutcome {
  if (typeof answer !== "string") {
    return { kind: "answered", value: answer };
  }
  try {
    return { kind: "answered", value: JSON.parse(answer) as unknown };
  } catch (parseFailure: unknown) {
    if (!(parseFailure instanceof SyntaxError)) {
      throw parseFailure;
    }
    return { kind: "refused", issue: `This is not valid JSON: ${parseFailure.message}` };
  }
}
