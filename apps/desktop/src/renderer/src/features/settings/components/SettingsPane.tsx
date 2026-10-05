// The pane: two empty states, or the page the address names.
//
// The page itself is `SettingsPageContent`, which holds hooks; this component may not, because
// both empty-state arms render before any section is resolved.
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { SettingsPageContent } from "./SettingsPageContent.js";
import type { SettingsPageRegistry } from "../settings-pages.js";
import type { SettingsPageContext } from "../types.js";
import type { SettingsPageId } from "#renderer/routing/settings-page-ids.js";

/** Props for {@link SettingsPane}. */
export interface SettingsPaneProps {
  readonly section: SettingsPageId | undefined;
  /** The address's own page segment, so an unknown one can be named back. */
  readonly attempted: string | undefined;
  readonly context: SettingsPageContext;
  readonly pages: SettingsPageRegistry;
  /**
   * How many search hits this pane has opened. It moves on every hit, including a second hit
   * on the section already open.
   */
  readonly settleOrdinal: number;
}

/**
 * The right-hand pane: the selected section's page, or the reason there is none.
 *
 * Two empty states stay apart because the next move differs: no section chosen (`#/settings`
 * invites a choice rather than picking one, which would tie the selection to tuple order),
 * and an unknown section (an error, named back).
 */
export function SettingsPane(props: SettingsPaneProps): React.JSX.Element {
  if (props.section === undefined) {
    if (props.attempted !== undefined) {
      return (
        <Nothing
          kind="error"
          placement="block"
          title="That settings address does not name a section."
          detail={
            `Nothing in settings is called “${props.attempted}”. The rail on ` +
            "the left lists every section this app has."
          }
        />
      );
    }
    return (
      <Nothing
        kind="empty"
        placement="block"
        title="Choose a section."
        detail="Settings are grouped by what they govern. Search above to jump straight to one."
      />
    );
  }

  return (
    <SettingsPageContent
      section={props.section}
      context={props.context}
      pages={props.pages}
      settleOrdinal={props.settleOrdinal}
    />
  );
}
