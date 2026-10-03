// `highlight.read`: the color spans of one piece of code, from the daemon's one colorer.
// Spans go out as the flat `[offset, length, class]` list the colorer keeps. The response schema
// refuses a list too big for one reply frame, so an oversized reply fails the read instead of
// closing the connection.
import { HIGHLIGHT_METHOD_DESCRIPTORS, HIGHLIGHT_READ_METHOD } from "@ai-sidekicks/contracts";
import type { MethodRegistry } from "@ai-sidekicks/contracts";

import type { CodeHighlighter } from "../../highlight/code-highlighter.js";
import { registerDescribedMethod } from "./register-described-method.js";

/** What `highlight.read` colors through. */
export interface HighlightReadDependencies {
  readonly highlighter: Pick<CodeHighlighter, "readSpans">;
}

/** Binds `highlight.read` onto the registry. */
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
