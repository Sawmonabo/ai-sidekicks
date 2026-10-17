// The app's logo mark: the app icon's own line drawing, read from the icon's source and painted as
// a mask in the hairline color, so the console never holds a second copy of the logo.

import "./LogoMark.css";

import appIconLinesUrl from "#build/icon.icon/Assets/tubes.svg?url";

/** The app's logo mark, hidden from assistive technology and out of the pointer's way. */
export function LogoMark(): React.JSX.Element {
  return (
    <div
      className="meridian-logo-mark"
      aria-hidden="true"
      style={{ maskImage: `url("${appIconLinesUrl}")` }}
    />
  );
}
