// The highlight worker — a module worker whose whole job is `tokenizeCode`.
//
// `Spec-023 §Console Libraries` puts shiki "in a Worker above about 4 kB of source", and
// `Spec-023 §Console Design (Meridian)`'s frame budget is why: the JavaScript regex
// engine costs about 8.1 ms per 2,700 bytes, so a 65,536-byte block is 183 ms — eleven
// frames if it runs where the ledger is drawing.
//
// IT IS AN ENTRY POINT, NOT A MODULE ANYBODY IMPORTS. `highlight-scheduler.ts` reaches
// it through `new Worker(new URL(…), { type: "module" })`, which the bundler resolves
// and emits as its own chunk; nothing imports it by specifier, which is why it is named
// as an entry in `apps/desktop/knip.json` — the dead-code gate resolves reachability
// through imports and a `new URL` is not one.
//
// IT HOLDS NO STATE OF ITS OWN. The realm's single highlighter and its loaded grammars
// live in `code-tokenizer.ts`, where the main-thread path finds them too; this file is
// the message loop and the message loop only.

import { tokenizeCode } from "./code-tokenizer.js";
import type { HighlightRequestMessage, HighlightResponseMessage } from "./highlight-protocol.js";

/**
 * The half of a worker's global scope this file uses.
 *
 * Declared here rather than taken from `DedicatedWorkerGlobalScope`, and that is a
 * fact about the compilation rather than a preference: the renderer project compiles
 * against `lib: ["es2023", "dom", "dom.iterable"]`, and the worker global lives in
 * `lib.webworker.d.ts`, which those do not include. Adding the webworker lib to the
 * whole renderer would make `postMessage`, `close`, and `self` resolve to the worker
 * realm in every component that never runs in one — a far larger claim than this file
 * needs. Two members is the whole surface, so the narrow structural type is also the
 * honest one.
 */
interface HighlightWorkerScope {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<HighlightRequestMessage>) => void,
  ): void;
  postMessage(message: HighlightResponseMessage): void;
}

/**
 * This worker's own global scope.
 *
 * `self` is typed as the window in a document context, so the cast is what tells the
 * compiler which realm this file runs in. It is the one place in this subtree that
 * asserts anything about its host, and it asserts exactly what the `new Worker` call
 * site already guarantees.
 */
const workerScope = self as unknown as HighlightWorkerScope;

workerScope.addEventListener("message", (event: MessageEvent<HighlightRequestMessage>) => {
  const request = event.data;
  // Fire-and-forget by design: every failure inside `tokenizeCode` is already answered
  // with `undefined`, so the only way this promise rejects is a defect in the message
  // loop itself, and a rejection handler that posted a second response would answer one
  // request twice.
  void tokenizeCode(request.source, request.language).then((lines) => {
    const response: HighlightResponseMessage = { requestId: request.requestId, lines };
    workerScope.postMessage(response);
  });
});
