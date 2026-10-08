import { HoverLabel } from "#renderer/components/HoverLabel/HoverLabel.js";

import "./ChangedFromDefaultMark.css";

/**
 * Props for `ChangedFromDefaultMark`: a switch hands in the position it ships in and the mark words
 * it; any other control hands in its default in words, such as `System by default`.
 */
export type ChangedFromDefaultMarkProps =
  | { readonly isOnByDefault: boolean }
  | { readonly defaultDescription: string };

/**
 * The small accent mark drawn after a control's name while its value differs from its default.
 * The caller draws it only then; assistive technology reads it as `Changed from the default`, and
 * its hover label names the default.
 */
export function ChangedFromDefaultMark(props: ChangedFromDefaultMarkProps): React.JSX.Element {
  return (
    <HoverLabel text={describeDefault(props)} textRole="description">
      <span
        className="meridian-settings-changed-mark"
        role="img"
        aria-label="Changed from the default"
      />
    </HoverLabel>
  );
}

function describeDefault(props: ChangedFromDefaultMarkProps): string {
  if ("defaultDescription" in props) {
    return props.defaultDescription;
  }
  return props.isOnByDefault ? "On by default" : "Off by default";
}
