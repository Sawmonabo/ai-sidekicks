// Renderer entrypoint.
//
// Mounts the <App /> tree into the `#root` element declared in
// apps/desktop/src/renderer/index.html using the React 19 idiomatic root API
// (`createRoot` from `react-dom/client` — replaces the legacy
// `ReactDOM.render` API removed in React 18, see React 19 release notes).
//
// Deliberately absent here, each waiting on the machinery it needs:
//   • No Sentry-renderer init (`@sentry/electron/renderer`). The Sentry SDK
//     does not auto-initialize renderers in v7; explicit init lands with the
//     dependency itself.
//   • No StrictMode wrapper. Opting in is a decision to take once real feature
//     views exist and the double-invocation diagnostic earns its noise.
//   • No `navigator.clipboard` runtime assertion. An
//     `expect(navigator.clipboard).toBeUndefined()` assertion catches
//     transitive-dep regressions; it lands alongside the ESLint
//     `no-restricted-imports` ban.
//
// The renderer is untrusted: NO imports of `electron` / `node:*` / `fs` /
// `path` / `process` / `os` / `child_process` / `net` / `./src/main/**` /
// `./src/preload/**`.

import { createRoot } from "react-dom/client";

import { App } from "./App.js";

/** The mount point `apps/desktop/src/renderer/index.html` declares. */
const ROOT_ELEMENT_ID = "root";

/**
 * Raised when the entry HTML carries no mount point.
 *
 * A named class rather than the `!` non-null assertion this used to carry.
 * Failing fast was the right posture; the assertion's problem is WHAT it fails
 * with — `createRoot(null)` throws React's own "Target container is not a DOM
 * element", a message that names neither the document that was supposed to
 * declare the element nor the id that was looked up, in a window whose only
 * other symptom is a white rectangle. Both facts are known here, so both are
 * stated here.
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
