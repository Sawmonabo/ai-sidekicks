import { Glyph } from "#renderer/components/Glyph/Glyph.js";
import { GLYPH_SIZE_CHROME } from "#renderer/styles/glyphs.js";

/** Props for {@link SettingsSearchField}. */
export interface SettingsSearchFieldProps {
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
}

/**
 * The one control above the rail.
 *
 * A plain search input, not a combobox: the results are a list of links, and announcing them
 * as an autocomplete would promise a keyboard grammar this field lacks.
 */
export function SettingsSearchField(props: SettingsSearchFieldProps): React.JSX.Element {
  return (
    <div className="meridian-settings__search">
      <Glyph name="search" size={GLYPH_SIZE_CHROME} />
      <input
        type="search"
        className="meridian-settings__search-input"
        value={props.query}
        placeholder="Search settings"
        aria-label="Search settings"
        onChange={(changeEvent) => {
          props.onQueryChange(changeEvent.target.value);
        }}
      />
    </div>
  );
}
