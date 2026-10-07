import type { ReactNode } from "react";

import { settingsControlAnchor } from "../control/anchor.js";
import type { SettingsControl } from "../types.js";

/**
 * One row of a settings page's facts grid: the app's word for the fact, then its value. A fact
 * named by a findable control takes that control's label as its term and its anchor, so search
 * lands on the row.
 */
export function SettingsFact(
  props: ({ readonly term: string } | { readonly control: SettingsControl }) & {
    readonly children: ReactNode;
  },
): React.JSX.Element {
  const isControl = "control" in props;
  return (
    <div
      className="meridian-settings-page__fact"
      {...(isControl ? settingsControlAnchor(props.control) : {})}
    >
      <dt>{isControl ? props.control.label : props.term}</dt>
      <dd>{props.children}</dd>
    </div>
  );
}
