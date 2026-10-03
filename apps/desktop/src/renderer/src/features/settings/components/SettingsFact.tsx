import type { ReactNode } from "react";

/** One row of a settings page's facts grid: the app's word for the fact, then its value. */
export function SettingsFact(props: {
  readonly term: string;
  readonly children: ReactNode;
}): React.JSX.Element {
  return (
    <div className="meridian-settings-page__fact">
      <dt>{props.term}</dt>
      <dd>{props.children}</dd>
    </div>
  );
}
