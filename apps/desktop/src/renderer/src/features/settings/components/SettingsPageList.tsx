import { SETTINGS_PAGE_IDS, type SettingsPageId } from "@renderer/routing/settings-page-ids.js";
import { SETTINGS_PAGE_LABELS } from "@renderer/features/settings/settings-page-labels.js";

/** Props for {@link SettingsPageList}. */
export interface SettingsPageListProps {
  readonly selectedSection: SettingsPageId | undefined;
  readonly onOpenSection: (section: SettingsPageId) => void;
}

/** Every section, always. The rail is the closed tuple and never a filtered view of it. */
export function SettingsPageList(props: SettingsPageListProps): React.JSX.Element {
  return (
    <nav aria-label="Settings sections">
      <ul className="meridian-settings__sections">
        {SETTINGS_PAGE_IDS.map((section) => (
          <li key={section}>
            <button
              type="button"
              className="meridian-settings__section"
              aria-current={section === props.selectedSection ? "page" : undefined}
              onClick={() => {
                props.onOpenSection(section);
              }}
            >
              {SETTINGS_PAGE_LABELS[section]}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
