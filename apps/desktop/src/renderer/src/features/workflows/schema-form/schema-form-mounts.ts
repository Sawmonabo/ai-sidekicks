// The only asynchronous edge into the schema form: the chunk loader and the two mounts the
// workflow views import in place of the components. The `import type` lines are erased, so the
// only runtime edge into `schema-form-body.ts` is the `import()` in `schemaFormChunk`.
// A pending form draws only the `reservedBodyRegion` marker: what is missing is a module, not
// anything about the phase, so no spinner or empty-state sentence.

import { LoaderBackedBody } from "@renderer/components/LazyBody/lazy-body.js";
import { reservedBodyRegion } from "@renderer/components/LazyBody/pending-body-marker.js";
import { MemoizedLoad } from "@renderer/lib/memoized-load.js";
import type { SchemaFormAnswerProps } from "./components/SchemaFormAnswer.js";
import type { SchemaFormPreviewProps } from "./components/SchemaFormPreview.js";

/** What the kit's chunk publishes, read off the chunk root; a type position opens no edge. */
export type SchemaFormModule = typeof import("./schema-form-body.js");

/**
 * What a pending form stamps so a capture can say which body was still loading. Not a pane kind:
 * the same form is mounted inside more than one kind of pane.
 */
const SCHEMA_FORM_PENDING_BODY = "schema-form";

/** The schema form chunk's loader: one fetch per page, however many forms ask. */
export const schemaFormChunk: MemoizedLoad<SchemaFormModule> = new MemoizedLoad(
  () => import("./schema-form-body.js"),
);

/**
 * The waiting phase's form, mounted from the chunk. `LoaderBackedBody` keeps one in-flight
 * promise and one component identity, and rebuilds only after a rejected load so a retry reaches
 * a live loader.
 */
export const schemaFormAnswerBody: LoaderBackedBody<SchemaFormAnswerProps> = new LoaderBackedBody(
  async () => ({ Body: (await schemaFormChunk.load()).SchemaFormAnswer }),
  () => reservedBodyRegion(SCHEMA_FORM_PENDING_BODY),
);

/** The form a phase will ask, mounted from the same chunk and the same memo. */
export const schemaFormPreviewBody: LoaderBackedBody<SchemaFormPreviewProps> = new LoaderBackedBody(
  async () => ({ Body: (await schemaFormChunk.load()).SchemaFormPreview }),
  () => reservedBodyRegion(SCHEMA_FORM_PENDING_BODY),
);
