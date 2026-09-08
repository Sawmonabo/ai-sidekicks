// The form stack's door: one component out, and the sheet that dresses it.
//
// A SUB-MODULE DOOR, PUBLISHING TO THIS FAMILY ONLY. The whole stack — the mapper, the
// hook, the six controls, the two containers, the raw editor — is reached through this
// one name, because there is exactly one surface in the console that holds a human
// phase's input schema: the definition detail, which reads a version body. A door
// publishing the pieces would be an invitation to compose a second form somewhere else
// out of parts that only agree when they are composed here.
//
// THE SHEET ENTERS HERE, at the barrel of the directory that owns it. Everything below
// draws against it and nothing above declares a class it holds, so the rules travel with
// whichever chunk reaches this door — today the builder pane's, which is where a
// definition is read.
//
// WHAT LEAVES AND WHAT DOES NOT. The preview leaves. `useSchemaForm`, `planSchemaForm`
// and `compileSchemaValidator` do not, and their absence is the boundary rather than an
// omission: a caller assembling those three itself would be a second answer to what a
// schema draws, and the one place a form is composed is `SchemaForm.tsx`.

import "./schema-form.css";

export { HumanPhaseFormPreview } from "./HumanPhaseFormPreview.js";
