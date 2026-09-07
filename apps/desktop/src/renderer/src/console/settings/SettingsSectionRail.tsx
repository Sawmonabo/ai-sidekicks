import {
  SETTINGS_SECTION_IDS,
  SETTINGS_SECTION_LABELS,
  type SettingsSectionId,
} from "./settings-sections.js";

export interface SettingsSectionRailProps {
  readonly selectedSection: SettingsSectionId | undefined;
  readonly onOpenSection: (section: SettingsSectionId) => void;
}

/** Every section, always. The rail is the closed tuple and never a filtered view of it. */
export function SettingsSectionRail(props: SettingsSectionRailProps): React.JSX.Element {
  return (
    <nav aria-label="Settings sections">
      <ul className="meridian-settings__sections">
        {SETTINGS_SECTION_IDS.map((section) => (
          <li key={section}>
            <button
              type="button"
              className="meridian-settings__section"
              aria-current={section === props.selectedSection ? "page" : undefined}
              onClick={() => {
                props.onOpenSection(section);
              }}
            >
              {SETTINGS_SECTION_LABELS[section]}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
