// The definition file's two sides as the definition detail's acts call them: the same
// two calls, with the module that performs them fetched first.
//
// WHY THIS MODULE EXISTS AT ALL. The reading side pulls in a YAML parser, a body reader
// and a tool-binding reader behind it. Importing the form module directly would put
// that whole sub-graph in the chunk that draws a definition, charged to every view of
// one whether or not anybody exports or imports it.
//
// SO THE ACTS IMPORT THIS, AND THIS NAMES THE WORK THROUGH `import()`. What stays on the
// graph is two function bodies and a type reference that erases; the form, its parser
// and everything under it are emitted as their own chunk and fetched the first time
// somebody presses export or import.
//
// AND THE DEFERRAL IS HERE RATHER THAN IN EACH CALLER. The export act and the import
// act both reach the form, and one wrapper beside it keeps the `import()` in one place
// rather than one copy per act.
//
// NO MEMO IS KEPT BESIDE IT. The module map is already the memo, there is no render
// state to observe, and a third copy of the loader class `terminal/emulator/
// emulator-loader.ts` and the phase graph's own already carry would be a class written
// for a caller that has no use for one.
//
// THE ONLY WAY THESE REJECT is a chunk that did not load, which is a fact about the
// install rather than about the definition — so it travels as a rejection to the
// calling act, which reports a rejected call, rather than as a sentence about a file
// that is fine.

import type {
  WorkflowDefinitionFileReading,
  WorkflowDefinitionImportTarget,
} from "./workflow-definition-file-form.js";
import type { WorkflowVersionBody } from "@renderer/services/wire-shapes/workflow-definition-body.js";

/**
 * Serialize one served version body into the file form, fetching the writer first.
 *
 * The VERSION body and not the definition read, because a file is one version's bytes:
 * the definition read carries the identity and the phase sequence and no schema marker,
 * so a file written from it could not say which schema it is in.
 */
export async function serializeWorkflowDefinitionFile(body: WorkflowVersionBody): Promise<string> {
  const { serializeDefinitionFile } = await import("./workflow-definition-file-form.js");
  return serializeDefinitionFile(body);
}

/**
 * Read pasted text as a definition file, fetching the reader first.
 *
 * THE TARGET IS THE CALLER'S AND NOT THE FILE'S — see `parseDefinitionFile`, which is
 * where the reading and its refusals are stated. This adds the fetch and nothing else.
 */
export async function parseWorkflowDefinitionFile(
  text: string,
  target: WorkflowDefinitionImportTarget,
): Promise<WorkflowDefinitionFileReading> {
  const { parseDefinitionFile } = await import("./workflow-definition-file-form.js");
  return parseDefinitionFile(text, target);
}
