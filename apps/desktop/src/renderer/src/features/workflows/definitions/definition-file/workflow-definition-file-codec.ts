// The definition file's two sides as the detail's acts call them, with the form module fetched
// first: the form pulls in a YAML parser and the body and binding readers, which would
// otherwise sit in the chunk that draws a definition. No memo, since the module map is one.
// These reject only when the chunk fails to load, a fact about the install and not the file.

import type {
  WorkflowDefinitionFileReading,
  WorkflowDefinitionImportTarget,
} from "./workflow-definition-file-form.js";
import type { WorkflowVersionBody } from "@renderer/services/wire-shapes/workflow-definition-body.js";

/**
 * Serialize one served version body into the file form, fetching the writer first. Takes the
 * version body, not the definition read, which carries no schema marker.
 */
export async function serializeWorkflowDefinitionFile(body: WorkflowVersionBody): Promise<string> {
  const { serializeDefinitionFile } = await import("./workflow-definition-file-form.js");
  return serializeDefinitionFile(body);
}

/**
 * Read pasted text as a definition file, fetching the reader first. The target is the caller's,
 * not the file's; see `parseDefinitionFile`.
 */
export async function parseWorkflowDefinitionFile(
  text: string,
  target: WorkflowDefinitionImportTarget,
): Promise<WorkflowDefinitionFileReading> {
  const { parseDefinitionFile } = await import("./workflow-definition-file-form.js");
  return parseDefinitionFile(text, target);
}
