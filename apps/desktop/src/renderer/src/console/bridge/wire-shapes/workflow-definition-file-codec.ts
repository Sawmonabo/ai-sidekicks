// The definition file's two sides as the door publishes them: the same two calls, with
// the module that performs them fetched first.
//
// WHY THIS MODULE EXISTS AT ALL. The bridge door is on the console's initial import
// graph — the renderer root reaches it — so every symbol the door names is charged to
// every launch. The only surfaces that export or import a definition file are lazily
// loaded workflow bodies, and the reading side pulls in a YAML parser, a body reader
// and a tool-binding reader behind it. Publishing those directly would put the whole
// sub-graph on a launch that never opens a definition, against the initial-bundle
// budget `Spec-023 §Console Design (Meridian)` sets.
//
// SO THE DOOR NAMES THIS, AND THIS NAMES THE WORK THROUGH `import()`. What stays on the
// graph is two function bodies and a type reference that erases; the codec, its parser
// and everything under it are emitted as their own chunk and fetched the first time
// somebody presses export or import.
//
// AND THE DEFERRAL IS HERE RATHER THAN IN THE CALLER. A view family may not reach past
// this family's door — `console-cross-family-deep-import` closes that — so a workflow
// body cannot `import()` the form module itself. The wrapper belongs on this side of
// the door, which is also where the reason for it is legible: the door's own eagerness
// is what has to be paid for.
//
// NO MEMO IS KEPT BESIDE IT. The module map is already the memo, there is no render
// state to observe, and a third copy of the loader class `terminal/emulator/
// emulator-loader.ts` and the phase graph's own already carry would be a class written
// for a caller that has no use for one.
//
// THE ONLY WAY THESE REJECT is a chunk that did not load, which is a fact about the
// install rather than about the definition — so it travels as a rejection to the
// surface's own rejection seam rather than as a sentence about a file that is fine.

import type {
  WorkflowDefinitionFileReading,
  WorkflowDefinitionImportTarget,
} from "./workflow-definition-file-form.js";
import type { WorkflowVersionBody } from "./workflow-definition-body.js";

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
