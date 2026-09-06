// The pane: three absences, or the page the address names.
//
// The PAGE itself is `SettingsSectionPage.tsx` beside this file, and the split is the
// package's one-component-per-module rule doing real work: that component holds hooks
// and this one may not, because two of the three arms below render before any section
// is resolved and a hook run for them would be reaching for a heading that is not on
// screen.
import { Nothing } from "../primitives/index.js";
import { SettingsSectionPage } from "./SettingsSectionPage.js";
import type {
  SettingsPageContext,
  SettingsPageRegistry,
  SettingsSectionId,
} from "./settings-page-registry.js";

export interface SettingsPaneProps {
  readonly section: SettingsSectionId | undefined;
  /** The address's own page segment, so an unknown one can be named back. */
  readonly attempted: string | undefined;
  readonly context: SettingsPageContext;
  readonly pages: SettingsPageRegistry;
  /**
   * How many search hits this surface has opened. Moves on every hit, including a
   * second hit on the section already open — which is the case a boolean could not
   * express, and the one where a reader most needs to be told they did not move.
   */
  readonly settleOrdinal: number;
}

/**
 * The right-hand pane: the selected section's page, or the reason there is none.
 *
 * Three distinct absences, kept apart because the next move differs:
 *
 *   • no section chosen — the address is `#/settings` with no page, so the pane
 *     invites a choice rather than picking one, which would make the rail's
 *     selection depend on tuple order.
 *   • a section the address named that does not exist — an error, named back.
 *   • a section with no page registered — reserved, not stubbed.
 */
export function SettingsPane(props: SettingsPaneProps): React.JSX.Element {
  if (props.section === undefined) {
    if (props.attempted !== undefined) {
      return (
        <Nothing
          kind="error"
          placement="surface"
          title="That settings address does not name a section."
          detail={`Nothing in settings is called “${props.attempted}”. The rail on the left lists every section this console has.`}
        />
      );
    }
    return (
      <Nothing
        kind="empty"
        placement="surface"
        title="Choose a section."
        detail="Settings are grouped by what they govern. Search above to jump straight to one."
      />
    );
  }

  return (
    <SettingsSectionPage
      section={props.section}
      context={props.context}
      pages={props.pages}
      settleOrdinal={props.settleOrdinal}
    />
  );
}
