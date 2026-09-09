// The pane harness's region, its two controls, and its count line.
//
// Split out of `PaneHarnessSurface.tsx` so that module declares one component. It is
// shared by every arm of the surface rather than repeated because the count line is
// what a driver reads to know how many bodies are mounted, and an arm that rendered
// an absence without it would leave a driver waiting on a line that never appears.
//
// Fixture-only, like the surface it frames: nothing production-side imports it, and
// under `__SIDEKICKS_CONSOLE_FIXTURES__ === false` the surface's registration
// collapses and this module leaves the bundle with it.

import type { ReactNode } from "react";

/** The surface region's accessible name — how a driver finds this surface. */
export const PANE_HARNESS_LABEL = "Pane harness";

/** The control that mounts one more instance of the addressed kind. */
export const OPEN_CONTROL_LABEL = "Open a pane";

/** The control that unmounts the newest one. */
export const CLOSE_CONTROL_LABEL = "Close the newest pane";

export interface PaneHarnessFrameProps {
  readonly instanceCount: number;
  /** The addressed kind, or absent on an arm that never resolved one. */
  readonly paneKindLabel: string | undefined;
  /** Absent on an arm with nothing to open, which is what disables the control. */
  readonly onOpen?: (() => void) | undefined;
  readonly onClose?: (() => void) | undefined;
  readonly children?: ReactNode;
}

export function PaneHarnessFrame(props: PaneHarnessFrameProps): React.JSX.Element {
  const { instanceCount, paneKindLabel, onOpen, onClose, children } = props;
  return (
    <section aria-label={PANE_HARNESS_LABEL}>
      <p>
        {/* The two facts a driver waits on, in one line: which kind is addressed
            and how many of it are mounted right now. */}
        {`${paneKindLabel ?? "no"} panes open: ${String(instanceCount)}`}
      </p>
      <button
        type="button"
        disabled={onOpen === undefined}
        onClick={() => {
          onOpen?.();
        }}
      >
        {OPEN_CONTROL_LABEL}
      </button>
      <button
        type="button"
        disabled={onClose === undefined || instanceCount === 0}
        onClick={() => {
          onClose?.();
        }}
      >
        {CLOSE_CONTROL_LABEL}
      </button>
      {children}
    </section>
  );
}
