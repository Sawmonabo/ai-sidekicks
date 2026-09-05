import { Glyph } from "../primitives/index.js";
import { SEARCH_GLYPH_SIZE } from "./SettingsSurface.js";

export interface SettingsSearchFieldProps {
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
}

/**
 * The one control above the rail.
 *
 * A plain `<input type="search">` with a visible label association rather than a
 * combobox: the results below are a navigable list of links, not an autocomplete
 * popover, and announcing them as one would promise a keyboard grammar this surface
 * does not implement.
 */
export function SettingsSearchField(props: SettingsSearchFieldProps): React.JSX.Element {
  return (
    <div className="meridian-settings__search">
      <Glyph name="search" size={SEARCH_GLYPH_SIZE} />
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
