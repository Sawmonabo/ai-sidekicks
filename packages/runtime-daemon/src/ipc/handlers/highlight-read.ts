// `highlight.read`: the color spans of one piece of code, from the daemon's one
// colorer.
//
// The spans leave the daemon as the flat `[offset, length, class]` list the
// colorer keeps. A span list too large for one reply frame is refused by the
// method's response schema, so an oversized reply fails the read instead of
// closing the connection; the surface then leaves the code plain.
import { HIGHLIGHT_METHOD_DESCRIPTORS, HIGHLIGHT_READ_METHOD } from "@ai-sidekicks/contracts";
import type { MethodRegistry } from "@ai-sidekicks/contracts";

import type { CodeHighlighter } from "../../highlight/code-highlighter.js";
import { registerDescribedMethod } from "./register-described-method.js";

/** What `highlight.read` colors through. */
export interface HighlightReadDependencies {
  readonly highlighter: Pick<CodeHighlighter, "readSpans">;
}

/** Bind `highlight.read`. */
export function registerHighlightRead(
  registry: MethodRegistry,
  dependencies: HighlightReadDependencies,
): void {
  registerDescribedMethod(
    registry,
    HIGHLIGHT_METHOD_DESCRIPTORS[HIGHLIGHT_READ_METHOD],
    async (request) => {
      const spans = await dependencies.highlighter.readSpans(request.source, request.language);
      return { spans: Array.from(spans) };
    },
  );
}
