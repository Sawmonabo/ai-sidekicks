// The schema form's chunk root: the one module an `import()` names, and everything the
// form offers the rest of the renderer reached through it.
//
// WHY IT EXISTS. Nothing on the first paint draws a schema. The views that do — the run
// page's waiting-phase form and a definition's phase preview — are loader-backed bodies
// of their own, so every module in this directory is needed only once one of them
// mounts. A symbol reachable both statically and dynamically is assigned to the STATIC
// chunk, so importing the two forms statically from a module the initial graph reaches
// would put this whole directory and the JSON-Schema validator behind it on the document
// every session downloads, whether or not a form is ever drawn.
//
// So the workflow views import `schema-form-mounts.ts` instead, and that module reaches
// this one through `import()` and through nothing else. This module is therefore
// the bundler's split point: everything only it reaches is emitted as its own chunk and
// fetched the first time a form mounts.
//
// AND THE STYLESHEET ENTERS HERE, at the module the chunk is rooted at, so it loads with
// the first schema form and never before.
//
// IT EXPORTS THE TWO COMPOSED FORMS AND NOTHING ELSE. `useSchemaForm` and
// `planSchemaForm` stay inside: a caller assembling them itself would be a second answer
// to what a schema draws. The schema COMPILER is not exported either: the form reaches
// it through `json-schema-validator-loader.ts`, a second chunk fetched when a form first
// compiles a schema, so the schema library never rides this root.

import "./schema-form.css";

export { SchemaFormAnswer } from "./components/SchemaFormAnswer.js";
export { SchemaFormPreview } from "./components/SchemaFormPreview.js";
