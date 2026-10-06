// A page that owns file tokens in a test, and can be told it loaded a new document or has gone.

import type { FilePathRefOwner } from "./file-path-refs.js";

/** A token owner with the id given, whose `navigate` and `destroy` run the listeners left. */
export function pageOwner(id: number): FilePathRefOwner & {
  readonly navigate: () => void;
  readonly destroy: () => void;
} {
  const navigateListeners: (() => void)[] = [];
  const destroyListeners: (() => void)[] = [];
  let isDestroyed = false;
  return {
    id,
    isDestroyed: () => isDestroyed,
    once: (_event, listener) => {
      destroyListeners.push(listener);
    },
    on: (_event, listener) => {
      navigateListeners.push(listener);
    },
    navigate: () => {
      for (const listener of navigateListeners) {
        listener();
      }
    },
    destroy: () => {
      isDestroyed = true;
      for (const listener of destroyListeners.splice(0)) {
        listener();
      }
    },
  };
}
