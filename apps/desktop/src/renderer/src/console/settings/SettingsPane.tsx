import { Nothing } from "../primitives/index.js";
import { type SettingsPageContext, type SettingsPageRegistry } from "./settings-page-registry.js";
import { SETTINGS_SECTION_LABELS, type SettingsSectionId } from "./settings-sections.js";

export interface SettingsPaneProps {
  readonly section: SettingsSectionId | undefined;
  /** The address's own page segment, so an unknown one can be named back. */
  readonly attempted: string | undefined;
  readonly context: SettingsPageContext;
  readonly pages: SettingsPageRegistry;
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

  const descriptor = props.pages.descriptorFor(props.section);
  const label = SETTINGS_SECTION_LABELS[props.section];
  return (
    <article className="meridian-settings__page" aria-label={label}>
      <h2 className="meridian-settings__page-heading">{descriptor?.label ?? label}</h2>
      <div className="meridian-settings__page-body">
        {descriptor === undefined ? (
          <Nothing
            kind="empty"
            placement="surface"
            title={`The ${label.toLowerCase()} page has not been built yet.`}
            detail="It is reserved rather than missing — the section exists and its page is still being built. Nothing was asked of the daemon for it."
          />
        ) : (
          descriptor.render(props.context)
        )}
      </div>
    </article>
  );
}
