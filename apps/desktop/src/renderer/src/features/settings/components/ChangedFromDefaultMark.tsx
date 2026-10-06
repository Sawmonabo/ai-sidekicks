import "./ChangedFromDefaultMark.css";

/** Props for `ChangedFromDefaultMark`. */
export interface ChangedFromDefaultMarkProps {
  /** The default in words, its tooltip: `On by default`. */
  readonly defaultDescription: string;
}

/**
 * The small accent mark drawn after a control's name while its value differs from its default.
 * The caller draws it only then; assistive technology reads it as `Changed from the default`.
 */
export function ChangedFromDefaultMark(props: ChangedFromDefaultMarkProps): React.JSX.Element {
  return (
    <span
      className="meridian-settings-changed-mark"
      role="img"
      aria-label="Changed from the default"
      title={props.defaultDescription}
    />
  );
}
