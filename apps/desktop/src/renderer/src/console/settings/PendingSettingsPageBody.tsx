// What a settings section renders while its page's module is still arriving.
//
// THE REGION AND NOTHING IN IT, which is the whole of the design here. `SettingsPane`
// has already drawn the page's frame and its heading from the descriptor by the time this
// renders — the label is registered beside the loader, so it is known without the body —
// so what is missing is the body alone and the honest reservation for it is the empty
// region the body will fill.
//
// NOT ONE OF THE FIVE KINDS OF NOTHING. `seats/PendingPaneBody.tsx` states the reasoning
// and it holds here unchanged: rule 8's five absences are claims about the ENTITY, and
// none of them is true of a module that has not landed. `not loaded` would say the page's
// read had not come back, which is a different sentence and a false one — the page has not
// been mounted, so it has asked the daemon for nothing.
//
// IT CARRIES THE SAME MARKER A PENDING PANE CARRIES, and deliberately not one of its own.
// The question a capture asks is a single question — is anything on this page still
// loading — and a second attribute would be a second sweep that agreed with the first
// until somebody forgot it. The marker's VALUE is the section id, so a refusal names the
// rail entry a person would recognise rather than the count of things pending.
//
// The marker rides a `hidden` element for that module's reason: `display: none`
// contributes no box, so what the reserved region costs the layout is nothing.

import { PENDING_PANE_BODY_ATTRIBUTE } from "../seats/index.js";
import type { SettingsSectionId } from "./settings-sections.js";

export interface PendingSettingsPageBodyProps {
  /** The rail section whose page is loading, so a refusal can name it. */
  readonly section: SettingsSectionId;
}

/** The settings page's region, before its body. */
export function PendingSettingsPageBody(props: PendingSettingsPageBodyProps): React.JSX.Element {
  return <span hidden {...{ [PENDING_PANE_BODY_ATTRIBUTE]: props.section }} />;
}
