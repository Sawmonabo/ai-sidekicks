// The argument names a registered callback tool's input schema declares.
//
// SEPARATE FROM THE ROW THAT RENDERS THEM because the row was doing this by eye and
// got it wrong: `SessionCallbackTool.inputSchema` is typed `Record<string, unknown>`,
// so `Object.keys` compiles, reads plausibly, and answers with the schema's own
// KEYWORDS — `type`, `properties`, `required`, `additionalProperties`. The panel that
// said "Input schema" therefore named none of the tool's arguments. Narrowing is the
// job, so it is a module with the narrowing's own cases beside it rather than an
// expression inside a list render.
//
// IT IS A READER AND NOT A VALIDATOR. Nothing here decides whether the daemon's
// schema is well-formed or reports that it is not: the registry is daemon-curated and
// daemon-trusted, and a console that refused to draw a row over a keyword it did not
// recognise would be asserting a schema dialect the wire never promised. A member
// that is not the shape JSON Schema names simply contributes no argument.
//
// REQUIRED FIRST, AND ORDER IS THE SCHEMA'S OWN OTHERWISE. What a person opening this
// panel wants first is what they must supply; within each group the declaration order
// is the daemon's and is left alone, because re-sorting names would be the console
// composing a schema of its own.

/** One argument a tool takes, as the disclosure panel names it. */
export interface CallbackToolArgument {
  readonly name: string;
  /** True where the schema's `required` list names it. */
  readonly isRequired: boolean;
}

/** The schema keyword naming each argument the tool accepts. */
const PROPERTIES_KEYWORD = "properties";

/** The schema keyword naming which of them must be supplied. */
const REQUIRED_KEYWORD = "required";

/**
 * Read the arguments one registered tool's input schema declares.
 *
 * An argument the schema REQUIRES but does not describe still gets a row: JSON Schema
 * admits that shape, and dropping it would report the tool as taking fewer arguments
 * than it does.
 */
export function callbackToolArguments(
  inputSchema: Record<string, unknown>,
): readonly CallbackToolArgument[] {
  const declared = declaredPropertyNames(inputSchema);
  const required = requiredArgumentNames(inputSchema);
  const undescribedRequired = required.filter((name) => !declared.includes(name));
  return [
    ...declared.filter((name) => required.includes(name)),
    ...undescribedRequired,
    ...declared.filter((name) => !required.includes(name)),
  ].map((name) => ({ name, isRequired: required.includes(name) }));
}

/** The names under `properties`, in the schema's own declaration order. */
function declaredPropertyNames(inputSchema: Record<string, unknown>): readonly string[] {
  if (!Object.hasOwn(inputSchema, PROPERTIES_KEYWORD)) {
    return [];
  }
  const properties = inputSchema[PROPERTIES_KEYWORD];
  // An array is an object too, and its keys are indices — which would list `0`, `1`
  // as argument names — so it is excluded here rather than surviving a `typeof`.
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) {
    return [];
  }
  return Object.keys(properties);
}

/** The names under `required`, keeping only the members JSON Schema admits. */
function requiredArgumentNames(inputSchema: Record<string, unknown>): readonly string[] {
  if (!Object.hasOwn(inputSchema, REQUIRED_KEYWORD)) {
    return [];
  }
  const required = inputSchema[REQUIRED_KEYWORD];
  return Array.isArray(required) ? required.filter((name) => typeof name === "string") : [];
}
