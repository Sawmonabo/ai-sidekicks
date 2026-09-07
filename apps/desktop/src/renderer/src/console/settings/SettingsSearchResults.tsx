import { Nothing } from "../primitives/index.js";
import { type SettingsEntryMatch } from "./settings-page-registry.js";
import { SETTINGS_SECTION_LABELS, type SettingsSectionId } from "./settings-sections.js";

export interface SettingsSearchResultsProps {
  readonly query: string;
  readonly matches: readonly SettingsEntryMatch[];
  readonly selectedSection: SettingsSectionId | undefined;
  readonly onOpenSection: (section: SettingsSectionId) => void;
}

/**
 * Ranked hits, each naming the section it landed in.
 *
 * A miss names the query and what was searched, which is the difference between "no
 * such setting" and "this console has not built that page yet" — and only the
 * second is true here, so the copy says the second.
 */
export function SettingsSearchResults(props: SettingsSearchResultsProps): React.JSX.Element {
  if (props.matches.length === 0) {
    return (
      <Nothing
        kind="empty"
        placement="surface"
        title={`Nothing in settings matches “${props.query}”.`}
        detail="Every section was searched by its name, its page heading, and its aliases. A section whose page has not been built here yet carries no searchable text."
      />
    );
  }
  return (
    <nav aria-label="Settings search results">
      <ul className="meridian-settings__sections">
        {props.matches.map((match) => (
          <li key={match.descriptor.section}>
            <button
              type="button"
              className="meridian-settings__section meridian-settings__section--result"
              aria-current={match.descriptor.section === props.selectedSection ? "page" : undefined}
              onClick={() => {
                props.onOpenSection(match.descriptor.section);
              }}
            >
              <span className="meridian-settings__result-label">{match.descriptor.label}</span>
              <span className="meridian-settings__result-section">
                {SETTINGS_SECTION_LABELS[match.descriptor.section]}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
