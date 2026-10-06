import { type SettingsSearchHit } from "../search.js";

/** Props for {@link SettingsSearchResults}. */
export interface SettingsSearchResultsProps {
  readonly hitsId: string;
  readonly query: string;
  readonly hits: readonly SettingsSearchHit[];
  readonly highlightedIndex: number | undefined;
  readonly hitIdAt: (hitIndex: number) => string;
  readonly onOpenHit: (hit: SettingsSearchHit) => void;
}

/**
 * The hits, each its label over the place it sits, or the one line a term nothing matches draws.
 */
export function SettingsSearchResults(props: SettingsSearchResultsProps): React.JSX.Element {
  if (props.hits.length === 0) {
    return (
      <p id={props.hitsId} className="meridian-settings__no-match" role="status">
        No setting matches “{props.query.trim()}”.
      </p>
    );
  }
  return (
    <ul
      id={props.hitsId}
      className="meridian-settings__hits"
      role="listbox"
      aria-label="Settings search results"
    >
      {props.hits.map((hit, hitIndex) => (
        <li
          key={`${hit.pageId}/${hit.controlId ?? ""}`}
          id={props.hitIdAt(hitIndex)}
          className="meridian-settings__hit"
          role="option"
          aria-selected={hitIndex === props.highlightedIndex}
          onClick={() => {
            props.onOpenHit(hit);
          }}
        >
          <span className="meridian-settings__hit-label">{hit.label}</span>
          <span className="meridian-settings__hit-place">{hit.place}</span>
        </li>
      ))}
    </ul>
  );
}
