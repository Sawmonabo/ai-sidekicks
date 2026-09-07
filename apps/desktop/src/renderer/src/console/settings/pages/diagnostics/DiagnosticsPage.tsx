// The diagnostics page: this machine's execution health, without opening a log.
//
// `Spec-023 §Console Design (Meridian)` §Diagnostics and health: "Make this machine's
// execution health visible without opening raw logs … Never polls. There is no health
// subscription, so the surface re-reads on focus, on reconnect, and on run-terminal
// events. Never partially masks diagnostic content … Never offers an outbound send …
// Never derives a health verdict of its own."
//
// FIVE OPERATIONS, ALL FIVE PUT
//
// The section names an overall status read, a stuck-run inspect, a failure-detail
// read, a recovery request, and the redaction-policy read. Every one of them is a
// registered daemon method, and none of them is exposed on `SidekicksBridge` yet — so
// each travels the growth port under the slate row this page owns, against the fixture
// today and against the wire the day it lands, with no call site here changing.
//
// `health.subscribe` is deliberately not among them. It is registered, and this
// section forbids it in as many words: there is no health subscription for this
// surface, and the three refresh signals are what stand in its place.
//
// EVERY CONTROL IS OFFERED, AND THIS PAGE COMPUTES NO PERMISSIONS
//
// The recovery controls are the sharpest thing on any settings page — one of them
// abandons a run — so the temptation to grey them out for a caller who may not press
// them is real, and it is refused. The node adjudicates a recovery request when it
// arrives; nothing on any of these five replies reports whether this caller's
// permissions would admit one, and a page that guessed would be a second authority on
// a question it cannot see. So the controls are always rendered, the request always
// leaves, and a refusal renders under the control that raised it in the refuser's own
// words. The only thing that ever disables a control here is this window's own
// in-flight write, which is a fact about this press rather than about authority.
//
// THE DIRECTORY IS GROUPED BY OPERATION, NOT FLAT
//
// Five operations, and each one's presentation is several modules: a badge and its two
// threshold rules, a prompt and its request and its outcome line, a banner and its
// loading arm, a read-out and its note. Flat, that was a page directory a reader had to
// scan to find which of two dozen files belonged to the stall reading. So four
// sub-directories name the operation groups — `health/`, `stall/`, `recovery/`,
// `redaction/` — and what stays at the root is what spans them: this page, the read-out
// that composes all four, the region wrapper and the arm-absence, the reading that
// drives the five calls, the shared vocabulary tables, the sheet, and the harness.
//
// NONE OF THE FOUR CARRIES A DOOR, which is this family's shape rather than an
// omission: every sub-directory under `settings/` is reached by its own specifier and
// `settings/index.ts` is the family's only barrel. `apps/desktop/AGENTS.md` states the
// condition — a sub-module directory is given a door when a SIBLING takes from it, and
// here every reader is the page's own root, one level up.
//
// The failure-detail card stays at the root deliberately: it is the one operation whose
// presentation is a single module, and a fifth directory holding one file would be a
// grouping that names nothing.
//
// THIS FILE IS THE FRAME AND HOLDS NO READING
//
// The reads, their refresh, and their disposal belong to `DiagnosticsReadOut`, which
// is mounted one of two ways depending on whether this window has a session store —
// the family's shape for an optional store. What is left here is the page's own prose:
// the lede, the posture chips, and the closing statement of what the surface never
// does, which are claims about THIS SURFACE and need no wire to make.

import type { ReactNode } from "react";

import { Chip } from "../../../primitives/index.js";
import { DiagnosticsReadOut } from "./DiagnosticsReadOut.js";
import { NO_DIAGNOSTICS_RUN_SUBJECTS } from "./stall/run-subjects.js";
import { SessionScopedDiagnostics } from "./SessionScopedDiagnostics.js";
import type { SettingsPageContext, SettingsPageRegistry } from "../../settings-page-registry.js";

/** The lane that owns this page, so an unfilled section names someone. */
const OWNER = "collaboration-settings-diagnostics";

/** What the page will not do, whatever the four readings say. */
const DIAGNOSTICS_RULES: readonly string[] = [
  "It sends nothing anywhere. Diagnostics are default-deny outbound, this page changes no policy, and there is no control here that would transmit any of it.",
  "It never shows a partly masked reading. Half-redacted personal data is not redacted, so a reading either arrives whole or is reported as absent.",
  "It never hides a failed run to keep the surface calm. A failure that was read is rendered, including the parts that are unflattering to this machine.",
  "It composes no verdict of its own. Every state on this page is the node's own word, and the component rows are never folded into a headline.",
  "It never polls. There is no health subscription for this surface, so it re-reads when you arrive, when the transport comes back, and when a run ends.",
];

export function DiagnosticsPage(props: { readonly context: SettingsPageContext }): ReactNode {
  const { bridge, retainedSessionStore } = props.context;
  return (
    <div className="meridian-settings-page">
      <p className="meridian-settings-page__lede">
        Everything here comes from the node itself — read when you arrive, when the transport comes
        back, and when a run ends, never on a timer. The run-scoped readings are about the session
        this window has open; work this machine is doing for sessions you have not opened is not
        reachable from here, and this page says so rather than reporting quiet.
      </p>

      <div className="meridian-settings-page__chips">
        <Chip tone="neutral" label="Read on focus, never polled" glyph="clock" />
        <Chip tone="neutral" label="Nothing leaves this machine" glyph="dot" />
        <Chip tone="attention" label="No verdict is composed here" glyph="alert" />
      </div>

      {retainedSessionStore === undefined ? (
        <DiagnosticsReadOut
          bridge={bridge}
          subjects={NO_DIAGNOSTICS_RUN_SUBJECTS}
          sessionStore={undefined}
        />
      ) : (
        <SessionScopedDiagnostics bridge={bridge} sessionStore={retainedSessionStore} />
      )}

      <section className="meridian-settings-page__block" aria-label="What this page never does">
        <h3 className="meridian-settings-page__block-title">What this page never does</h3>
        <ul className="meridian-settings-page__list">
          {DIAGNOSTICS_RULES.map((rule) => (
            <li key={rule}>{rule}</li>
          ))}
        </ul>
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
    render: (context) => <DiagnosticsPage context={context} />,
  });
}
