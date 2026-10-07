import { Glyph } from "#renderer/components/Glyph/Glyph.js";
import { GLYPH_SIZE_CHROME } from "#renderer/styles/glyphs.js";

/** Props for {@link SettingsSearchField}. */
export interface SettingsSearchFieldProps {
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly onKeyDown: (keyEvent: React.KeyboardEvent) => void;
  /** The id of the hits list this box controls, or `undefined` while no list is drawn. */
  readonly hitsId: string | undefined;
  /** The id of the lit hit, or `undefined` while none is drawn. */
  readonly highlightedHitId: string | undefined;
}

/**
 * The one box above the page list, a combobox over its hits: focus stays here while the arrows
 * light a hit, and the lit hit is named to assistive technology as the active option.
 */
export function SettingsSearchField(props: SettingsSearchFieldProps): React.JSX.Element {
  return (
    <div className="meridian-settings__search">
      <Glyph name="search" size={GLYPH_SIZE_CHROME} />
      <input
        type="search"
        role="combobox"
        className="meridian-settings__search-input"
        value={props.query}
        placeholder="Search settings"
        aria-label="Search settings"
        aria-autocomplete="list"
        aria-controls={props.hitsId}
        aria-expanded={props.highlightedHitId !== undefined}
        aria-activedescendant={props.highlightedHitId}
        onChange={(changeEvent) => {
          props.onQueryChange(changeEvent.target.value);
        }}
        onKeyDown={props.onKeyDown}
      />
    </div>
  );
}
