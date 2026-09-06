// The health banner: the node's own verdict, and the components it was reached over.
//
// `Spec-023 §Console Design (Meridian)` §Diagnostics and health: "A health banner from
// `health.statusRead`: an overall verdict plus per-component rows over `healthy`,
// `degraded`, and `blocked`." Its states section adds the two shapes this component
// draws: "Empty: all components healthy, the banner collapses to one quiet line.
// Loading: per-component skeletons."
//
// THE VERDICT IS CARRIED, NEVER COMPOSED. `overall` arrives on the reply and is
// rendered as it came. A banner that folded the component rows into a headline would
// be deriving a health verdict, which the same section forbids — and would be wrong in
// the one case that matters, because a machine with one blocked component is not the
// average of the ones that are fine.
//
// WHICH IS ALSO WHY THE QUIET LINE IS GATED ON THE COMPONENTS AND NOT ON THE VERDICT.
// The design's empty state is "all components healthy", so the collapse asks exactly
// that question of the rows; a node reporting `degraded` overall while every component
// it listed reads `healthy` still shows its rows, because the disagreement is the most
// interesting thing on the page and hiding it would be this console deciding the
// verdict was a mistake.

import type { ReactNode } from "react";

import { Chip, DerivedFigure, Nothing, formatDateTime } from "../../../primitives/index.js";
import type { GrowthHealthComponent, GrowthHealthState } from "../../../bridge/index.js";
import { HEALTH_STATE_TONES, HEALTH_STATE_WORDS } from "./health-vocabulary.js";

export function HealthBanner(props: {
  readonly overall: GrowthHealthState;
  readonly components: readonly GrowthHealthComponent[];
}): ReactNode {
  const { overall, components } = props;
  const isAllHealthy =
    components.length > 0 && components.every((component) => component.state === "healthy");
  return (
    <div className="meridian-health-banner">
      <p className="meridian-health-banner__verdict">
        <Chip tone={HEALTH_STATE_TONES[overall]} label={HEALTH_STATE_WORDS[overall]} glyph="dot" />
        <span className="meridian-health-banner__verdict-text">
          {isAllHealthy
            ? "This machine reports every component it checked as healthy."
            : "This machine's own verdict, over the components below."}
        </span>
      </p>
      {isAllHealthy ? null : (
        <ul className="meridian-health-banner__components">
          {components.map((component) => (
            <li key={component.name} className="meridian-health-banner__component">
              <Chip
                tone={HEALTH_STATE_TONES[component.state]}
                label={HEALTH_STATE_WORDS[component.state]}
              />
              <span className="meridian-health-banner__component-name">{component.name}</span>
              <span className="meridian-health-banner__component-checked">
                checked <DerivedFigure text={formatDateTime(component.lastChecked)} />
              </span>
            </li>
          ))}
        </ul>
      )}
      {components.length === 0 ? (
        <Nothing
          kind="empty"
          placement="inline"
          title="This machine named no components."
          detail="The verdict above is all the node reported. Nothing is folded in from anywhere else to fill the gap."
        />
      ) : null}
    </div>
  );
}
