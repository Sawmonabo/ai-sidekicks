// The one edge into the schema form kit's code, and the only one that is asynchronous.
//
// WHAT THIS MODULE IS. `schema-form-body.ts` is the kit's chunk root and states why the
// kit is off the initial import graph; this module is the half that stays ON it — the
// loader the seats door publishes, the two mounts the door's component lines became, and
// nothing else. It holds no schema knowledge and imports no module of this directory at
// run time: the two `import type` lines below are erased by the compiler, so the only
// runtime edge into the chunk is the `import()` inside {@link SchemaFormChunk}.
//
// WHY A CLASS AND NOT A MODULE-LEVEL PROMISE, on `phase-graph-loader.ts`'s reasoning and
// for its reason: the promise has to be memoised so a run pane and a definition row
// mounting in one frame start one fetch rather than two, and a module-level `let`
// holding it is the state `apps/desktop/AGENTS.md` rejects — untestable, because there
// would be no second instance to compare a first against. The memo is a private field,
// and the page's loader is one `const` beside the class.
//
// ONE MEMO FOR ALL THREE CONSUMERS. Both mounts load through the same instance, and so
// does the submit path's reading of the attachment carrier, so the chunk is fetched once
// however many of them ask first. Two `LoadedLazyBody` loaders naming the specifier
// themselves would be two memos over one chunk — correct, because the module registry
// dedupes the fetch, and still two answers to whether the kit has arrived.
//
// WHAT THE RESERVED REGION IS. A form whose module is in flight draws the marker
// `pending-pane-body.ts` owns and nothing else: no spinner, no skeleton, and none of
// rule 8's five kinds of nothing — `PendingPaneBody.tsx` states that reasoning in full
// and it holds unchanged here, because what is absent is a MODULE rather than anything
// about the phase. The marker rides a `hidden` element, so what the wait costs the
// layout is nothing, and the screenshot tier refuses to photograph a tree carrying one.

import { createElement } from "react";

import { LoadedLazyBody } from "../lazy-body.js";
import { PENDING_PANE_BODY_ATTRIBUTE } from "../pending-pane-body.js";
import type { SchemaFormAnswerProps } from "./SchemaFormAnswer.js";
import type { SchemaFormPreviewProps } from "./SchemaFormPreview.js";

/**
 * What the kit's chunk publishes, read off the chunk root rather than restated.
 *
 * `typeof import(...)` in a TYPE position is erased by the compiler — it opens no
 * runtime edge into the chunk this module exists to keep off the initial graph — and
 * reading the root's own shape means a rename behind it fails here instead of drifting.
 */
export type SchemaFormKit = typeof import("./schema-form-body.js");

/**
 * What a pending form stamps, so a capture can say WHICH body was still loading.
 *
 * The marker's value is the body's name for `pendingPaneKindsIn`'s message. Not a pane
 * kind, because this body is not a pane — it is mounted INSIDE one, and the same form is
 * drawn by more than one kind, so a kind here would name the wrong thing on some of them.
 */
const SCHEMA_FORM_PENDING_BODY = "schema-form";

/** The schema form chunk's loader: one fetch per page, however many forms ask. */
export class SchemaFormChunk {
  #modulePromise: Promise<SchemaFormKit> | undefined;

  /** Whether the chunk has been asked for yet. The memo, observable. */
  public get isLoadStarted(): boolean {
    return this.#modulePromise !== undefined;
  }

  /**
   * The kit, fetched once. Every later call gets the same promise, so a run pane and a
   * definition row mounting together share one fetch rather than racing two.
   */
  public load(): Promise<SchemaFormKit> {
    this.#modulePromise ??= this.#fetchKit();
    return this.#modulePromise;
  }

  async #fetchKit(): Promise<SchemaFormKit> {
    try {
      return await import("./schema-form-body.js");
    } catch (loadError) {
      // A chunk that did not arrive is not a chunk that cannot: the fetch fails
      // transiently. Memoising the rejection would leave every later mount for the life
      // of the window holding a failure a second request would not have reproduced, so
      // the memo is dropped and the caller that asked still sees this attempt's error.
      this.#modulePromise = undefined;
      throw loadError;
    }
  }
}

/** The page's loader. A test builds its own; nothing else does. */
export const schemaFormChunk: SchemaFormChunk = new SchemaFormChunk();

/** The reserved region a form leaves while its module is still arriving. */
function reservedFormRegion(): React.ReactNode {
  return createElement("span", {
    hidden: true,
    [PENDING_PANE_BODY_ATTRIBUTE]: SCHEMA_FORM_PENDING_BODY,
  });
}

/**
 * The waiting phase's form, mounted from the chunk.
 *
 * A `LoadedLazyBody` rather than a `lazy()` of this module's own, because that class is
 * already the console's one answer to a loader-backed body: it holds the single in-flight
 * promise, keeps one component identity so a host re-render does not remount the form,
 * rebuilds only when a load rejected so the error boundary's retry reaches a live
 * loader, and renders the settled body directly once the chunk has landed — so a form
 * opened after any earlier one never suspends at all.
 */
export const schemaFormAnswerMount: LoadedLazyBody<SchemaFormAnswerProps> = new LoadedLazyBody(
  async () => ({ Body: (await schemaFormChunk.load()).SchemaFormAnswer }),
  reservedFormRegion,
);

/** The form a phase WILL ask, mounted from the same chunk and the same memo. */
export const schemaFormPreviewMount: LoadedLazyBody<SchemaFormPreviewProps> = new LoadedLazyBody(
  async () => ({ Body: (await schemaFormChunk.load()).SchemaFormPreview }),
  reservedFormRegion,
);
