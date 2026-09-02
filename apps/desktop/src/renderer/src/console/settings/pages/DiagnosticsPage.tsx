// The diagnostics page: this machine's execution health, without opening a log.
//
// `Spec-023 §Console Design (Meridian)` §Diagnostics and health: "Make this
// machine's execution health visible without opening raw logs … Never polls. There
// is no health subscription, so the surface re-reads on focus, on reconnect, and on
// run-terminal events. Never partially masks diagnostic content … Never offers an
// outbound send … Never derives a health verdict of its own."
//
// NOT ONE OF THE FIVE READS IS REGISTERED, AND THE PAGE SAYS SO IN FIVE PLACES
//
// The section names five operations — an overall status read, a stuck-run inspect,
// a failure-detail read, a recovery request, and the redaction-policy read.
// `packages/contracts` registers no health request or response type, no
// `SidekicksBridge` namespace carries one, and the growth port has no operation for
// any of them (its one health entry is a SUBSCRIPTION, which this section forbids
// outright — "there is no health subscription"). So there is nothing to call, and
// this page's whole job today is to be honest about that.
//
// It is honest per REGION rather than once at the top. The five absences are five
// different missing answers, and a person looking for a stuck run wants to know
// that nothing was asked about stuck runs — not that "diagnostics is unavailable",
// which reads as a failure of the machine rather than of the console.
//
// WHY NO RECOVERY BUTTONS ARE DRAWN DISABLED
//
// The recovery prompt offers three actions, and the honest rendering of a control
// whose wire does not exist is its absence with the reason, not a greyed-out button
// with a tooltip: a disabled control still claims the capability exists and that
// this person may not use it, which is a statement about permissions the console is
// forbidden to make. `Spec-023`'s own rule — eligibility is never derived in the
// renderer — is the same rule read from the other side.
//
// THE POSTURE PROSE IS THIS CONSOLE'S OWN CLAIM, NOT A READ
//
// What the page says about polling, masking, and outbound sends describes what THIS
// SURFACE does, which it knows without asking anyone. It states no verdict about
// the daemon's policy, because that is the policy read-out's answer and the
// read-out has not been performed.

import type { ReactNode } from "react";

import { Chip, Nothing } from "../../primitives/index.js";
import type { SettingsPageRegistry } from "../settings-page-registry.js";

/** The lane that owns this page, so an unfilled section names someone. */
const OWNER = "collaboration-settings-diagnostics";

/**
 * One region of the page: what it would show, and what was never asked for it.
 *
 * A table rather than five hand-written blocks, because the five regions differ
 * only in their copy and a reader comparing them should be comparing sentences
 * rather than markup. Every entry renders the same shape, which is what makes the
 * "five different absences" claim checkable by counting rendered regions.
 */
interface DiagnosticsRegion {
  readonly id: string;
  readonly heading: string;
  readonly whatItWouldShow: string;
  readonly absenceTitle: string;
  readonly absenceDetail: string;
}

const DIAGNOSTICS_REGIONS: readonly DiagnosticsRegion[] = [
  {
    id: "status",
    heading: "Execution health",
    whatItWouldShow:
      "One verdict for this machine over its components, each carrying its own healthy, degraded, or blocked reading — never folded into a single number, because a component that is blocked is not the average of the ones that are fine.",
    absenceTitle: "This machine's health has not been read.",
    absenceDetail:
      "No status read is registered for this console yet, so nothing was asked and no verdict is shown. A green banner composed here would be this window's guess, not the daemon's answer.",
  },
  {
    id: "stuck",
    heading: "Stuck runs",
    whatItWouldShow:
      "A run that has stopped making progress, marked once it has been quiet for a minute and marked more insistently at five, with the daemon's own suggestion rendered as guidance rather than as another button.",
    absenceTitle: "No run was inspected.",
    absenceDetail:
      "The stuck-run inspection is not registered for this console yet. An empty region here means the question was never put — not that every run is moving.",
  },
  {
    id: "failure",
    heading: "Failure detail",
    whatItWouldShow:
      "What actually failed, told apart by class rather than reported as one generic error, so a provider that refused and a worktree that vanished do not read the same.",
    absenceTitle: "No failure detail has been read.",
    absenceDetail:
      "The failure-detail read is not registered for this console yet. Runs that failed still show their own terminal state in the timeline; what is missing here is the classified detail behind it.",
  },
  {
    id: "recovery",
    heading: "Recovery",
    whatItWouldShow:
      "Three ways out of a stuck run — try it again, interrupt it, or abandon it — offered as a prompt, with the daemon's refusal rendered on whichever one you press.",
    absenceTitle: "No recovery action can be requested from here.",
    absenceDetail:
      "The recovery request is not registered for this console yet. The three controls are absent rather than disabled: a greyed-out button would claim the action exists and that you may not take it, and neither half of that is something this window knows.",
  },
  {
    id: "redaction",
    heading: "Diagnostic redaction",
    whatItWouldShow:
      "Which diagnostic material is kept, how long each kind survives, and a prominent notice whenever a retention override is in force.",
    absenceTitle: "The redaction policy has not been read.",
    absenceDetail:
      "The policy read is not registered for this console yet. Nothing about retention is summarised from memory here, because a policy quoted from anywhere but the daemon is a policy nobody is bound by.",
  },
];

export function DiagnosticsPage(): ReactNode {
  return (
    <div className="meridian-settings-page">
      <p className="meridian-settings-page__lede">
        Everything this page would show comes from the node itself, read when you arrive and when
        something ends — never on a timer. Today none of those reads is registered for this console,
        so each region below says what it would carry and that nothing was asked for it.
      </p>

      <div className="meridian-settings-page__chips">
        <Chip tone="neutral" label="Read on focus, never polled" glyph="clock" />
        <Chip tone="neutral" label="Nothing leaves this machine" glyph="dot" />
        <Chip tone="attention" label="No verdict is composed here" glyph="alert" />
      </div>

      {DIAGNOSTICS_REGIONS.map((region) => (
        <section
          key={region.id}
          className="meridian-settings-page__block"
          aria-label={region.heading}
        >
          <h3 className="meridian-settings-page__block-title">{region.heading}</h3>
          <p className="meridian-settings-page__aside">{region.whatItWouldShow}</p>
          <Nothing
            kind="not-checked"
            placement="surface"
            title={region.absenceTitle}
            detail={region.absenceDetail}
          />
        </section>
      ))}

      <section className="meridian-settings-page__block" aria-label="What this page never does">
        <h3 className="meridian-settings-page__block-title">What this page never does</h3>
        <div className="meridian-settings-page__prose">
          <p>
            It sends nothing anywhere. Diagnostics stay on this machine unless somebody deliberately
            exports them, and this page changes no policy and offers no way to transmit one.
          </p>
          <p>
            It never shows a partly masked reading. Half-redacted personal data is not redacted, so
            a reading either arrives whole or is reported as absent — and a failed run is never
            hidden to keep this page looking calm.
          </p>
        </div>
      </section>
    </div>
  );
}

/** Claim the diagnostics section. See `RuntimeNodesPage.tsx` on the seam's shape. */
export function registerDiagnosticsPage(registry: SettingsPageRegistry): void {
  registry.register({
    section: "diagnostics",
    owner: OWNER,
    label: "Diagnostics and health",
    keywords: ["health", "stuck", "failure", "recovery", "logs", "redaction", "retention", "debug"],
    render: () => <DiagnosticsPage />,
  });
}
