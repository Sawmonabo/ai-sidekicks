// The target chip's axis surface: one press, one form, loaded when it is opened.
//
// WHAT THIS MODULE IS AND IS NOT. It is the trigger, the popover, and the context the
// form is handed. It is not the form: `ProviderSwitch` is the agents family's, and it
// stays there because the vocabulary it renders — drivers, models, effort levels,
// output speed, the dependent-axis chain, the settlement projection — is that family's
// and a second copy in the composer would be the copy nobody diffs.
//
// SO IT ARRIVES AS A CHUNK AND NOT AS AN IMPORT. `console/agents/index.ts` is imported
// eagerly by `session-surfaces-family.ts`, so a door line for the component would put the
// form, the combobox stack, the draft model, and three stylesheets on the initial graph
// of every launch — including every session nobody ever opens this on. What crosses the
// door is `loadProviderSwitchBody`, whose `import()` is the only static reference to any
// of it, and the module's own chunk root is what dresses it.
//
// THE PORTAL IS THE PRIMITIVE'S, WHICH IS THE RULE AND NOT A PREFERENCE.
// `Popover.Root` and the trigger stay here because which surface is open is this
// component's state, but the portal, the positioner, and the popup are
// `primitives/overlay/OverlayPopoverPopup.tsx`'s — that is what registers the popup in
// the window's airspace, and a composer that mounted its own portal would be a form a
// native browser-pane view paints over and eats the input of.
//
// THE TRIGGER IS ITS OWN CONTROL RATHER THAN THE BINDING CHIP MADE PRESSABLE. A chip
// is one fact in one word and the binding clause is a wire-verbatim figure; turning a
// figure into a button would make the thing a person reads and the thing they press the
// same element, and the accessible name would then be a provider string rather than the
// act. The button says what pressing it does.

import { useState } from "react";
import { Popover } from "@base-ui/react/popover";

import {
  loadProviderSwitchBody,
  type ProviderSwitchBodyContext,
} from "../../../console/agents/index.js";
import { Nothing, OverlayPopoverPopup } from "../../../console/primitives/index.js";
import { LoadedLazyBody } from "../../../console/seats/index.js";
import type { TargetAxisControl } from "./target-axis-reach.js";

/** How far the popup sits off the control that opened it. */
const AXIS_POPOVER_SIDE_OFFSET = 6;

/**
 * What stands in the form's place while its chunk is in flight.
 *
 * The `not-loaded` kind and not `not-checked`: the read behind this surface is armed
 * and the participant's press has been taken — what is missing is the code, which is
 * a different absence from a question nobody asked (rule 8's five kinds).
 *
 * Declared at module level so the identity handed to the constructor is stable, and
 * named in camelCase because it is a fallback renderer rather than a component this
 * module is called after.
 */
const renderPendingAxisForm = (): React.ReactNode => (
  <Nothing kind="not-loaded" title="Opening the provider axes" />
);

export interface TargetAxisPopoverProps {
  readonly control: TargetAxisControl;
}

export function TargetAxisPopover(props: TargetAxisPopoverProps): React.JSX.Element {
  // Constructed once and kept, per `apps/desktop/AGENTS.md`: the `lazy()` form inside
  // is what React reconciles the body by, so a second one built on a later render is a
  // second component type and the open form would be unmounted and rebuilt underneath
  // the participant mid-edit.
  const [loadedBody] = useState(
    () =>
      new LoadedLazyBody<ProviderSwitchBodyContext>(loadProviderSwitchBody, renderPendingAxisForm),
  );
  const { agent, catalog, switching } = props.control;
  // Assembled at render rather than memoised: `LazyBody` spreads this as the body's
  // props and pins the component by identity, so a fresh record costs a re-render of a
  // form that is already re-rendering and buys back nothing. Every member is handed
  // straight through — this composer holds no second opinion about any of them.
  const context: ProviderSwitchBodyContext = {
    agent,
    catalog: catalog.catalog,
    onCatalogReopen: catalog.reopen,
    onApply: switching.apply,
    isSubmitting: switching.isSubmitting,
    round: switching.settled,
    refusal: switching.refusal,
  };
  return (
    <Popover.Root>
      <Popover.Trigger className="meridian-composer__axes-trigger">
        Change provider axes
      </Popover.Trigger>
      <OverlayPopoverPopup
        sideOffset={AXIS_POPOVER_SIDE_OFFSET}
        className="meridian-composer__axes-popover"
      >
        {loadedBody.render(context)}
      </OverlayPopoverPopup>
    </Popover.Root>
  );
}
