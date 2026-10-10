// The working indicator: three stepped bars that say work is under way, drawn beside a line that
// says what the work is, so the bars themselves are hidden from assistive technology.

import "./WorkingIndicator.css";

/** The three stepped bars that say work is under way; the line beside them says what it is. */
export function WorkingIndicator(): React.JSX.Element {
  return (
    <span className="meridian-working-indicator" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}
