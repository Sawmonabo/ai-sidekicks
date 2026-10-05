// A page that owns file tokens in a test, and can be told it has gone.

import type { FilePathRefOwner } from "./file-path-refs.js";

/** A token owner with the id given, whose `destroy` runs the listener `FilePathRefs` left. */
export function pageOwner(id: number): FilePathRefOwner & { readonly destroy: () => void } {
  const listeners: (() => void)[] = [];
  return {
    id,
    once: (_event, listener) => {
      listeners.push(listener);
    },
    destroy: () => {
      for (const listener of listeners.splice(0)) {
        listener();
      }
    },
  };
}
