import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { type SettingsPageMatch } from "../settings-pages.js";
import { type SettingsPageId } from "#renderer/routing/settings-page-ids.js";
import { SETTINGS_PAGE_LABELS } from "#renderer/features/settings/settings-page-labels.js";

/** Props for {@link SettingsSearchResults}. */
export interface SettingsSearchResultsProps {
  readonly query: string;
  readonly matches: readonly SettingsPageMatch[];
  readonly selectedSection: SettingsPageId | undefined;
  readonly onOpenSection: (section: SettingsPageId) => void;
}

/** Ranked hits, each naming its section; a miss names the query and what was searched. */
export function SettingsSearchResults(props: SettingsSearchResultsProps): React.JSX.Element {
  if (props.matches.length === 0) {
    return (
      <Nothing
        kind="empty"
        placement="block"
        title={`Nothing in settings matches “${props.query}”.`}
        detail="Every section was searched by its name, its page heading, and its aliases."
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
                {SETTINGS_PAGE_LABELS[match.descriptor.section]}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
