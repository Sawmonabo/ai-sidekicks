/**
 * Reads the options a Codex ask offers (a request for user input or an elicitation) into one
 * bounded option set.
 */

import {
  DRIVER_PROVIDER_COMMAND_DESCRIPTION_MAX_LEN,
  DRIVER_PROVIDER_DECLARED_TOKEN_MAX_LEN,
  wireFreeFormString,
} from "@ai-sidekicks/contracts";
import { isPlainObject } from "./record-readers.js";

// Ask choice sets: providers publish an ask's choices in provider-specific shapes, so they are
// normalized here, where session and run identity is stamped, for the input-ask card. The reading
// is derived (`params` still travels verbatim); an unreadable or over-large set is dropped because
// the free-text arm still answers.

/**
 * One selectable answer of a provider ask: `value` is what a chooser sends back, `label` what a
 * person reads (the titled MCP form publishes a distinct pair, the other only a label).
 */
export interface ProviderAskOption {
  readonly value: string;
  readonly label: string;
}

/** The most options one ask may carry; string-length bounds do not limit how many a set holds. */
export const CODEX_ASK_OPTION_SET_MAX = 64;

/** Option string bounds; the label gets the wider width because a titled MCP `title` is prose. */
const CODEX_ASK_OPTION_VALUE_MAX_LEN = DRIVER_PROVIDER_DECLARED_TOKEN_MAX_LEN;

const CODEX_ASK_OPTION_LABEL_MAX_LEN = DRIVER_PROVIDER_COMMAND_DESCRIPTION_MAX_LEN;

const codexAskOptionValueSchema = wireFreeFormString(
  CODEX_ASK_OPTION_VALUE_MAX_LEN,
  "ProviderAskOption.value",
);

const codexAskOptionLabelSchema = wireFreeFormString(
  CODEX_ASK_OPTION_LABEL_MAX_LEN,
  "ProviderAskOption.label",
);

/**
 * What one ask's payload yielded when read for a choice set. `absent` (no choices) is distinct
 * from `dropped` (choices this driver refused to carry), so only the latter earns a diagnostic.
 */
export type CodexAskOptionSetReading =
  | { readonly kind: "absent" }
  | { readonly kind: "read"; readonly options: readonly ProviderAskOption[] }
  | { readonly kind: "dropped"; readonly reason: string; readonly declaredCount: number };

const ABSENT_ASK_OPTION_SET: CodexAskOptionSetReading = Object.freeze({ kind: "absent" as const });

/**
 * Reads the choice set an inbound ask publishes, if any. Pure: it emits no diagnostic, so the
 * caller decides what a `dropped` reading is worth. `item/tool/requestUserInput` is read although
 * gated off by `experimentalApi: false`, so its disposition is defined when the gate opens.
 */
export function readCodexAskOptionSet(method: string, params: unknown): CodexAskOptionSetReading {
  if (method === "item/tool/requestUserInput") {
    return readCodexRequestUserInputOptionSet(params);
  }
  if (method === "mcpServer/elicitation/request") {
    return readCodexElicitationOptionSet(params);
  }
  // Approval methods publish a decision vocabulary the daemon composes; it must not appear on the
  // user's card.
  return ABSENT_ASK_OPTION_SET;
}

/**
 * Reads `ToolRequestUserInputParams.questions[].options`. An option has no value member at the
 * pin, so `value === label`; `description` is not carried, to keep prose out of the answer slot.
 * Eligible only for a single-question ask, since a flat set has no question identity.
 */
function readCodexRequestUserInputOptionSet(params: unknown): CodexAskOptionSetReading {
  if (!isPlainObject(params)) {
    return ABSENT_ASK_OPTION_SET;
  }
  const questions = params["questions"];
  if (!Array.isArray(questions)) {
    return ABSENT_ASK_OPTION_SET;
  }
  const optionBearing = questions.filter(
    (question): question is Record<string, unknown> =>
      isPlainObject(question) &&
      Array.isArray(question["options"]) &&
      question["options"].length > 0,
  );
  if (optionBearing.length === 0) {
    return ABSENT_ASK_OPTION_SET;
  }
  // The ask's own question count decides, not the option-bearing subset.
  if (questions.length > 1) {
    return {
      kind: "dropped",
      reason:
        "the ask declares more than one question and a single flat choice set carries no question identity, so no answer built from it could satisfy the ask",
      declaredCount: questions.length,
    };
  }
  const declared = optionBearing[0]?.["options"];
  if (!Array.isArray(declared)) {
    return ABSENT_ASK_OPTION_SET;
  }
  return boundCodexAskOptionSet(
    declared.map((option) => {
      const label = isPlainObject(option) ? option["label"] : undefined;
      return { value: label, label };
    }),
  );
}

/**
 * Reads the `McpServerElicitationRequestParams` single-select enum set; only `form` mode has a
 * typed schema, so other modes read absent. Multi-select (an array answer) is not read, and only a
 * one-property form is eligible, since the answer is keyed by property.
 */
function readCodexElicitationOptionSet(params: unknown): CodexAskOptionSetReading {
  if (!isPlainObject(params) || params["mode"] !== "form") {
    return ABSENT_ASK_OPTION_SET;
  }
  const requestedSchema = params["requestedSchema"];
  if (!isPlainObject(requestedSchema)) {
    return ABSENT_ASK_OPTION_SET;
  }
  const properties = requestedSchema["properties"];
  if (!isPlainObject(properties)) {
    return ABSENT_ASK_OPTION_SET;
  }
  const declaredSets = Object.values(properties)
    .map((property) => readCodexElicitationEnumArm(property))
    .filter((candidates): candidates is readonly unknown[] => candidates !== null);
  if (declaredSets.length === 0) {
    return ABSENT_ASK_OPTION_SET;
  }
  // The form's own property count decides, not the enum-bearing subset; a sibling's `required` is
  // not consulted, since an optional text sibling is equally unanswerable by a bare value.
  const propertyNames = Object.keys(properties);
  if (propertyNames.length > 1) {
    return {
      kind: "dropped",
      reason:
        "the elicitation form declares more than one property and a flat choice set carries no property identity, so no answer built from it could satisfy the form",
      declaredCount: propertyNames.length,
    };
  }
  const candidates = declaredSets[0] ?? [];
  return boundCodexAskOptionSet(candidates);
}

/** The `{ value, label }` candidates one elicitation property declares, or `null`. */
function readCodexElicitationEnumArm(property: unknown): readonly unknown[] | null {
  if (!isPlainObject(property)) {
    return null;
  }
  const titled = property["oneOf"];
  if (Array.isArray(titled) && titled.length > 0) {
    return titled.map((option) => {
      if (!isPlainObject(option)) {
        return { value: undefined, label: undefined };
      }
      return { value: option["const"], label: option["title"] };
    });
  }
  const values = property["enum"];
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }
  const names = property["enumNames"];
  return values.map((value, index) => {
    const declaredName = Array.isArray(names) ? names[index] : undefined;
    // The legacy arm pairs by position and its names array may be short; a missing caption falls
    // back to the value.
    return { value, label: typeof declaredName === "string" ? declaredName : value };
  });
}

/**
 * Bounds one candidate set, or says why it was refused. All-or-nothing: a partial set would hide a
 * choice the provider offered, whereas the free-text arm can express any answer.
 */
function boundCodexAskOptionSet(candidates: readonly unknown[]): CodexAskOptionSetReading {
  if (candidates.length === 0) {
    return ABSENT_ASK_OPTION_SET;
  }
  if (candidates.length > CODEX_ASK_OPTION_SET_MAX) {
    return {
      kind: "dropped",
      reason: `the ask declares more options than the ${CODEX_ASK_OPTION_SET_MAX}-entry cardinality bound admits`,
      declaredCount: candidates.length,
    };
  }
  const options: ProviderAskOption[] = [];
  for (const candidate of candidates) {
    const source = isPlainObject(candidate) ? candidate : {};
    const value = codexAskOptionValueSchema.safeParse(source["value"]);
    const label = codexAskOptionLabelSchema.safeParse(source["label"]);
    if (!value.success || !label.success) {
      return {
        kind: "dropped",
        reason:
          "at least one declared option carried an unreadable or out-of-bounds value or label, and a partial set would hide a choice the provider is waiting for",
        declaredCount: candidates.length,
      };
    }
    options.push({ value: value.data, label: label.data });
  }
  return { kind: "read", options: Object.freeze(options) };
}
