// The argument names a registered callback tool's input schema declares. A reader, not a
// validator: a member that is not the shape JSON Schema names contributes no argument.
// Required arguments come first, then the schema's own declaration order. `Object.keys` on
// the schema would list its keywords, which is why this is a module of its own.

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
 * The arguments one tool's input schema declares. A required argument the schema does not
 * describe still gets a row, so the tool is not reported as taking fewer than it does.
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
  // An array is an object too and its keys are indices, so it is excluded explicitly.
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
