// Crash reporting: the opt-out, and an honest account of what a report contains.
//
// `Spec-023 §Console Design (Meridian)` §Crash reporting: "An opt-out toggle, on by
// default, and copy that names what is stripped: session identifiers reduced to
// stable hashes, file paths reduced to extensions, and no content payloads. The
// coverage is stated as main process, renderer, and child and utility processes."
//
// TWO THINGS THIS COPY DELIBERATELY DOES NOT SAY
//
//   • **Who receives a report.** The sink is not settled anywhere in the corpus,
//     and naming one would be a claim nobody has made.
//   • **That a report is anonymous.** A stable hash is stable — it links this
//     machine's reports to each other — and a stripped path still says which
//     extension crashed. Calling that anonymous would be a comfortable lie, so the
//     copy says exactly what is removed and stops there.
//
// The toggle rides the shell-config preference carrier every settings toggle
// shares, which is what that section names ("through the shell-config preference
// carrier on the growth slate … held renderer-side until that carrier lands").
//
// This is one BLOCK of the application page rather than a page of its own: the
// closed section set has no crash-reporting section, and crash reporting is a fact
// about this application, which is where `ApplicationPage.tsx` composes it.

import type { ReactNode } from "react";

import type { ConsoleBridge } from "../../bridge/index.js";
import { PreferenceToggleRow } from "./PreferenceToggleRow.js";
import { useShellPreferences } from "./shell-preferences/shell-preferences-holder.js";

/** The one key this block spends. Named once so the row and its note cannot drift. */
const CRASH_REPORT_KEY = "diagnostics.crashReports";

export function CrashReportingPage(props: { readonly bridge: ConsoleBridge }): ReactNode {
  const preferences = useShellPreferences(props.bridge);
  const isEnabled = preferences.isEnabled(CRASH_REPORT_KEY);
  return (
    <section className="meridian-settings-page__block" aria-label="Crash reporting">
      <h3 className="meridian-settings-page__block-title">Crash reporting</h3>

      <PreferenceToggleRow
        label="Send a report when this application crashes"
        description="Covers the main process, the window you are looking at, and the child and utility processes behind them."
        checked={isEnabled}
        isPending={preferences.isPending(CRASH_REPORT_KEY)}
        note={
          preferences.isHeldLocally(CRASH_REPORT_KEY)
            ? "Held in this window. The shell preference store has not been built yet, so this choice takes effect at the next launch only once that store exists."
            : undefined
        }
        refusal={preferences.refusalFor(CRASH_REPORT_KEY)}
        onCheckedChange={(checked) => {
          preferences.choose(CRASH_REPORT_KEY, checked);
        }}
      />

      <div className="meridian-settings-page__prose">
        <p>A report carries the crash itself and as little else as it can:</p>
        <ul className="meridian-settings-page__list">
          <li>Session identifiers are replaced with stable hashes.</li>
          <li>File paths are reduced to their extension.</li>
          <li>No message text, no code, no tool output — no content payloads at all.</li>
        </ul>
        <p className="meridian-settings-page__aside">
          A stable hash is still stable: reports from this installation can be told apart from
          another&rsquo;s. That is not the same as being anonymous, and this console will not tell
          you it is.
        </p>
      </div>
    </section>
  );
}
