import { AnnouncedLine } from "#renderer/components/AnnouncedLine/AnnouncedLine.js";
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
 * The hits, each its label over the place a control sits, or the one line a term nothing matches
 * draws.
 */
export function SettingsSearchResults(props: SettingsSearchResultsProps): React.JSX.Element {
  if (props.hits.length === 0) {
    // It mounts holding its words when the last hit goes, so it says them through the announcer.
    return (
      <AnnouncedLine
        element="p"
        className="meridian-settings__no-match"
        words={`No setting matches “${props.query.trim()}”.`}
        politeness="polite"
      />
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
          <span>{hit.label}</span>
          {hit.place === undefined ? null : (
            <span className="meridian-settings__hit-place">{hit.place}</span>
          )}
        </li>
      ))}
    </ul>
  );
}
