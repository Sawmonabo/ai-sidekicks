// The schema form's chunk root, the one module an `import()` names. Nothing on first paint draws
// a schema, so the workflow views import `schema-form-mounts.ts`, which reaches this module only
// through `import()`; a static import would put this directory on the initial document.
// Exports the two composed forms only; the stylesheet enters here so it loads with the first form.

import "./schema-form.css";

export { SchemaFormAnswer } from "./components/SchemaFormAnswer.js";
export { SchemaFormPreview } from "./components/SchemaFormPreview.js";
