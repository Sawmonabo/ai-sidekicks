// The left rail: which steps there are, which are done, and which one is open.
//
// EVERY STEP STAYS REACHABLE, including the ones already recorded: a person may go
// back to a step they finished, which is why the rail lists all of them rather than
// only the ones ahead. What "done" means is the daemon's — the completed set arrives
// on the state read and nothing here re-derives it.
//
// A LIST OF BUTTONS AND NOT A TAB SET. Each entry moves the right pane and nothing
// else; there is no selection state to persist, no keyboard grammar beyond the
// ordinary tab order, and no roving index, because the rail is three entries long and
// a windowed-list treatment would be machinery for a list that fits.

import { ONBOARDING_STEPS_IN_ORDER, type OnboardingStepId } from "./step-model.js";

export interface StepRailProps {
  readonly completed: ReadonlySet<OnboardingStepId>;
  readonly openStepId: OnboardingStepId;
  readonly onOpenStep: (stepId: OnboardingStepId) => void;
}

export function StepRail(props: StepRailProps): React.JSX.Element {
  return (
    <nav className="meridian-onboarding__rail" aria-label="Setup steps">
      <ol className="meridian-onboarding__rail-list">
        {ONBOARDING_STEPS_IN_ORDER.map((step) => {
          const isOpen = step.id === props.openStepId;
          const isDone = props.completed.has(step.id);
          return (
            <li key={step.id}>
              <button
                type="button"
                className={
                  isOpen
                    ? "meridian-onboarding__rail-entry meridian-onboarding__rail-entry--open"
                    : "meridian-onboarding__rail-entry"
                }
                aria-current={isOpen ? "step" : undefined}
                onClick={() => {
                  props.onOpenStep(step.id);
                }}
              >
                <span className="meridian-onboarding__rail-label">{step.label}</span>
                <span className="meridian-onboarding__rail-state">
                  {isDone ? "Done" : "Not done"}
                </span>
                <span className="meridian-onboarding__rail-summary">{step.summary}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
