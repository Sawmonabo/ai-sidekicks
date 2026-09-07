// Where the engine event record lives, since nothing serves it.
//
// The workflow surface's own rule is what puts this sentence on this page: it "never
// exposes the engine event record. It is non-canonical by `Spec-017 §Engine event
// record (SA-43)`, no wire method serves it, and no replay, verification, rebuild or
// audit path may read it; the diagnostics page names its bundle location instead."
//
// SO THIS NAMES THE TIER AND NOT A PATH. The corpus places the record on the
// Plan-020-owned bounded-retention diagnostic tier and specifies no filesystem
// location for it anywhere; a renderer that printed an absolute path would be
// inventing the one fact a person would act on. The tier IS the location a person
// needs: it is the thing a diagnostic bundle is collected from, and its retention is
// the read-out above rather than a second figure written here.
//
// AND IT IS A STATEMENT, NOT A CONTROL. There is no collect button, no reveal-in-
// finder, and no copy-path: nothing in the console is registered to produce a bundle,
// and a control that looked like it would is worse than the sentence that says it
// does not exist.

import type { ReactNode } from "react";

export function BundleLocationNote(): ReactNode {
  return (
    <div className="meridian-settings-page__prose">
      <p>
        Workflow runs write an engine event record while they execute. It is not part of the
        session&rsquo;s canonical history, no method serves it, and nothing that rebuilds, verifies
        or audits a session reads it — its whole job is to explain a run afterwards.
      </p>
      <p>
        It is written to this machine&rsquo;s bounded-retention diagnostic tier, which is the same
        tier the retention table above reports on, and it is collected from there. This console
        neither reads it nor offers a way to package it: there is no bundle control here, because
        nothing is registered to produce one.
      </p>
    </div>
  );
}
