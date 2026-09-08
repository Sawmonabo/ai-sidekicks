// The form stack's door: two components out, and the sheet that dresses them.
//
// A SUB-MODULE DOOR, PUBLISHING TO THIS FAMILY ONLY. The whole stack — the mapper, the
// hook, the six controls, the two containers, the raw editor — is reached through these
// two names, because a human phase's input schema reaches this console at exactly two
// surfaces: the definition detail, which reads a version body, and the run pane, whose
// run read now carries the waiting phase's own prompt and schema. A door publishing the
// pieces would be an invitation to compose a third form somewhere else out of parts that
// only agree when they are composed in this directory.
//
// WHICH IS WHY THE SECOND COMPOSER IS HERE RATHER THAN AT ITS MOUNT. The run pane's
// human form is composed in `HumanPhaseFormAnswer.tsx` beside the preview, not in the
// slot that mounts it: the pieces stay in, the composers come out, and the surface that
// wanted a form gets one rather than a kit.
//
// THE SHEET ENTERS HERE, at the barrel of the directory that owns it. Everything below
// draws against it and nothing above declares a class it holds, so the rules travel with
// whichever chunk reaches this door — today the builder pane's, where a definition is
// read, and the run pane's, where one is answered.
//
// WHAT LEAVES AND WHAT DOES NOT. The two composed surfaces leave. `useSchemaForm`,
// `planSchemaForm` and `compileSchemaValidator` do not, and their absence is the
// boundary rather than an omission: a caller assembling those three itself would be a
// second answer to what a schema draws, and the one place a form is drawn is
// `SchemaForm.tsx`.

import "./schema-form.css";

export { HumanPhaseFormAnswer } from "./HumanPhaseFormAnswer.js";
export { HumanPhaseFormPreview } from "./HumanPhaseFormPreview.js";
