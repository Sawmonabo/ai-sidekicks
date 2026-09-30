// Renderer entrypoint: mounts `<App />` into the `#root` element of
// `apps/desktop/src/renderer/index.html` with React's `createRoot`.
//
// The renderer is untrusted: it imports no Node or Electron module (`electron`, `node:*`, `fs`,
// `path`, `process`, `os`, `child_process`, `net`) and nothing from main or preload.

import { createRoot } from "react-dom/client";

import { App } from "@renderer/app/App.js";

import "./styles/global-sheets.js";

/** The mount point `apps/desktop/src/renderer/index.html` declares. */
const ROOT_ELEMENT_ID = "root";

/**
 * Raised when the entry HTML carries no mount point. It names the document and the id, which
 * React's own "Target container is not a DOM element" does not, in a window whose only other
 * symptom is a white rectangle.
 */
class MissingRootElementError extends Error {
  public constructor() {
    super(
      `renderer entry document declares no #${ROOT_ELEMENT_ID} element ` +
        `(expected it in apps/desktop/src/renderer/index.html) — nothing to mount into`,
    );
    this.name = "MissingRootElementError";
  }
}

const container = document.getElementById(ROOT_ELEMENT_ID);
if (container === null) {
  throw new MissingRootElementError();
}

createRoot(container).render(<App />);
