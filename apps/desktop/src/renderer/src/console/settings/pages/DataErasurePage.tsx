// The data page: what this release actually does with a request to erase.
//
// `Spec-023 §Console Design (Meridian)` §Data and erasure: "Tell the truth about
// what this release does with a purge request … Offers nothing. There is no export
// control and no erase control, because the three `gdpr.*` methods return an
// unconditional not-implemented stub in this release … Never renders a button that
// would call a stub. Never implies an automated endpoint exists. Never claims data
// is provably destroyed on demand."
//
// SO THIS PAGE HAS NO CONTROL AT ALL, AND THAT IS THE FEATURE
//
// Every other settings page in this console offers something. This one offers
// nothing, and a reviewer looking for the missing button should read that as the
// deliberate shape rather than as an unfinished lane: a control here would call a
// method that answers "not implemented" and a person would reasonably conclude
// their data had been queued for deletion. The section says, in words, that erasure
// is an operator procedure in this release and what the retention posture around it
// is.
//
// THE FOUR AUDIT ROWS ARE NAMED FROM THE CONTRACT, NEVER SPELLED HERE
//
// A purge leaves audit stubs behind, and those four kinds are registered
// `SessionEventType`s. They are listed below as a tuple ANNOTATED with that union,
// so a rename in `packages/contracts` fails this file to compile rather than
// leaving the page naming a kind the wire no longer carries. They render mono and
// verbatim, which is the console's rule for a string the wire supplies.
//
// The rows themselves are the timeline's to draw — this page is not a second
// timeline, and the design says so ("the rows are chapter 5's row vocabulary; this
// section adds only prose"). What is here is the vocabulary plus the sentence that
// makes it legible.

import type { ReactNode } from "react";

import type { SessionEventType } from "@ai-sidekicks/contracts";

import { Chip } from "../../primitives/index.js";
import type { SettingsPageRegistry } from "../settings-page-registry.js";

/** The lane that owns this page, so an unfilled section names someone. */
const OWNER = "collaboration-settings-data";

/**
 * The audit stubs a purge leaves in the log.
 *
 * Annotated with the contract's own union rather than left as bare strings: that
 * annotation is the whole reason the list is safe to write down, because a kind
 * that stopped being registered would stop compiling here.
 */
const PURGE_AUDIT_EVENT_KINDS: readonly SessionEventType[] = [
  "session.purge_requested",
  "session.purged",
  "participant.purge_requested",
  "participant.purged",
];

export function DataErasurePage(): ReactNode {
  return (
    <div className="meridian-settings-page">
      <p className="meridian-settings-page__lede">
        Erasure in this release is an operator procedure, run against the node rather than from this
        window. There is no button here that would start one, because there is no endpoint behind it
        — and a control that answered &ldquo;not implemented&rdquo; after you pressed it would be
        worse than its absence.
      </p>

      <section className="meridian-settings-page__block" aria-label="What a purge leaves behind">
        <h3 className="meridian-settings-page__block-title">What a purge leaves behind</h3>
        <div className="meridian-settings-page__prose">
          <p>
            A completed purge is not a silence. Four audit rows stay in the session&rsquo;s log —
            the request and the completion, for a session and for one person — and they carry no
            personal content of their own. They are ordinary durable rows and appear in the timeline
            beside everything else that happened.
          </p>
        </div>
        <div className="meridian-settings-page__chips">
          {PURGE_AUDIT_EVENT_KINDS.map((kind) => (
            <Chip key={kind} tone="neutral" label={kind} mono />
          ))}
        </div>
      </section>

      <section className="meridian-settings-page__block" aria-label="The retention posture">
        <h3 className="meridian-settings-page__block-title">The posture this operates under</h3>
        <div className="meridian-settings-page__prose">
          <p>
            Durable session content is held encrypted, and a person&rsquo;s own typed content is
            keyed so it can be destroyed with their key rather than hunted for row by row.
            Diagnostic material is a separate, bounded tier that ages out on its own schedule and is
            never the canonical record of anything.
          </p>
          <p>
            What this console will not tell you is that your data has been provably destroyed the
            moment you ask. Rows die with the store that holds them, backups age out on their own
            clock, and a claim of on-demand destruction that ignored either would be a claim this
            release cannot keep.
          </p>
        </div>
      </section>
    </div>
  );
}

/** Claim the data section. See `RuntimeNodesPage.tsx` on the seam's shape. */
export function registerDataErasurePage(registry: SettingsPageRegistry): void {
  registry.register({
    section: "data",
    owner: OWNER,
    label: "Data and erasure",
    keywords: ["erase", "delete", "purge", "export", "retention", "privacy", "gdpr", "audit"],
    render: () => <DataErasurePage />,
  });
}
