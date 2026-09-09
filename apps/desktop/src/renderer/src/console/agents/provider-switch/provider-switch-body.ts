// The provider switch as a body a SECOND family may mount, and its own chunk root.
//
// WHY A THIRD ROOT RATHER THAN A DOOR LINE. `console/agents/index.ts` is imported
// eagerly by `collaboration-family.ts`, so every module that door reaches statically
// is on the initial graph of every launch — its own header says so, and it is why the
// family's eight sheets enter at chunk roots. A door line for `ProviderSwitch` would
// put the form, the combobox stack, the draft model, and the settlement projection on
// every session that never opens one, and the sheets with them. So the composer's
// target chip reaches this form the way both agent-console mounts already do: through
// a loader, whose `import()` is the only static reference to the code behind it.
//
// AND NOT A FOURTH MOUNT OF THE AGENT CONSOLE. The two agent-console roots load
// `AgentConsoleBody` — the machines column, the cards, the attach dialog, the linkage
// view — because that is what those mounts draw. A chip popover draws one form, so
// loading either of those roots to reach it would charge the popover the whole console.
//
// THE THREE SHEETS ARE DERIVED FROM WHAT THIS SUBTREE DRAWS, not copied from the pair.
// `ProviderSwitch`, `AxisCombobox`, and `SwitchSettlementLine` between them name
// `meridian-switch*`, `meridian-axis-field*`, and `meridian-settlement*`; the classes
// are declared by `provider-switch.css`, `axis-field.css`, and — for the control shape
// and the focus rules the other two refine — `agents.css`. The ORDER is the family's
// and is load-bearing for that last reason, which is why `agents.css` is named first
// exactly as it is at the other two roots. The four sheets those roots additionally
// name dress surfaces this one never renders.
//
// A sheet may cross a chunk boundary only where no other family declares a class it
// declares, because load order decides equal-specificity conflicts. All three are
// already at the agent-console roots on that finding
// (`test/console/architecture/stylesheet-selector-owners.test.ts`), and three chunk
// roots under one owning barrel are alternative entries to one directory rather than
// three owners — which is the one fan-in `stylesheet-edges.test.ts` admits.
//
// Named `Body` because `seats/lazy-body.ts` fixes the export name a loader resolves.
import "../agents.css";
import "../axis-field.css";
import "./provider-switch.css";

import { createElement } from "react";

import { ProviderSwitch, type ProviderSwitchProps } from "./ProviderSwitch.js";

/**
 * What a host hands this body: exactly {@link ProviderSwitchProps}, unwidened.
 *
 * An ALIAS and not a second declaration. The form's props are the contract, and a
 * context shape restating them would be a second answer to what the switch needs —
 * the one that goes stale is the copy, and nothing would report it. What the alias
 * buys is a name a loader's type parameter can carry without a caller reaching past
 * the door into the component module.
 */
export type ProviderSwitchBodyContext = ProviderSwitchProps;

/**
 * The switch, over the context its host resolved.
 *
 * `createElement` rather than calling the component: the form's hooks belong to the
 * form, and invoking it inline would splice them into whichever host rendered this.
 */
export function Body(context: ProviderSwitchBodyContext): React.ReactNode {
  return createElement(ProviderSwitch, context);
}
