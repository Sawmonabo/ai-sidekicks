// Electron main-process entrypoint.
//
// Plan-023 Phase 1 (T-023p-1-3) substrate: single-instance lock + main window.
// Tier 8 remainder layers Sentry init, daemon supervisor (`utilityProcess.fork`),
// custom-protocol handler (`sidekicks://`), deep-link routing, auto-updater,
// crash reporter, and second-instance focus handling against this same surface.
//
// See docs/plans/023-desktop-shell-and-renderer.md §Files In Scope line 257.

import { app } from "electron";
import { createMainWindow } from "./window.js";

// Plan-023 §Risks And Blockers: without `requestSingleInstanceLock()`, a
// `sidekicks://invite/<token>` deep-link arriving at a second instance would
// race with the first instance's daemon state. The lock is the correct pattern
// even at Tier 1, before the deep-link handler ships at Tier 8 remainder.
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app
    .whenReady()
    .then(() => {
      createMainWindow();
    })
    .catch((err: unknown) => {
      // Tier 1 substrate: structured logging routes through Sentry main at
      // Tier 8 remainder. Until then, surface startup failures on stderr.
      console.error("[ai-sidekicks/desktop] startup failed:", err);
      app.exit(1);
    });

  app.on("window-all-closed", () => {
    // Quit on all platforms at Tier 1; macOS-specific dock-keep-alive behavior
    // wires in at Tier 8 remainder once the full app lifecycle is wired.
    app.quit();
  });
}
