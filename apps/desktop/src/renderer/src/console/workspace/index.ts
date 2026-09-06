// The workspace family's door.
//
// The family holds the session sidebar — this family's own body, and the one view
// family surface the composer authors inside `console/`. The seats it renders
// through live one layer down, in `console/seats/`: a section is filled by whoever
// owns it, and a consumer reaching the sidebar through this door acquires no edge
// to a section's owner.
//
// WHY THE SIDEBAR IS HERE AND NOT IN A FAMILY OF ITS OWN. The sidebar renders
// sections three families own. A family of its own would be one more view family
// the other two had to import, which `console-view-family-isolation` forbids and
// which is exactly what the seats exist to make unnecessary.
//
// NO BARREL CHAIN. Every specifier below names the module that DECLARES the symbol
// rather than a second `index.ts` — `console-no-barrel-chain` reports the second
// hop, and a door that published a name it never declared would make a symbol's
// home a matter of following two files instead of reading one line.

// THE STYLESHEET IS IMPORTED HERE, and here only. `SidebarSection.tsx` and
// `SidebarResizeHandle.tsx` carry `.meridian-sidebar__*` classes and are importable
// without `Sidebar.tsx`, so a surface mounting one of them alone — an auxiliary
// window, a section host — rendered unstyled while the sheet's only edge hung off a
// component. The bundler now sees one edge per family rather than one per component,
// which is what every other family's door already does.
import "./sidebar/sidebar.css";

// The dead-code exemption names the task that will import the symbol, on the terms
// `apps/desktop/AGENTS.md` sets: the deck that mounts the sidebar has not landed.
// The tag is deleted by that task, in the PR that does the importing.
export {
  /** @consumedBy T-023p-1C-2 */
  Sidebar,
  /** @consumedBy T-023p-1C-2 */
  type SidebarProps,
} from "./sidebar/Sidebar.js";

// The sidebar sections this family fills, through the seat like every other family.
// It ships through this door because the composition root that calls it sits
// outside the console and reaches a family through its barrel — and it is a CALL
// rather than a module side effect, so importing anything here fills no seat.
export { registerComposerSidebarSections } from "./sidebar/sections/section-registration.js";
