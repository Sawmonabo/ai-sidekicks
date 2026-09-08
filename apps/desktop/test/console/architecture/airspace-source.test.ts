// What the airspace gate's SOURCE PREDICATES answer, driven over planted snippets.
//
// The claims are `airspace-registration.test.ts`'s and the source shapes are
// `airspace-source.ts`'s — the seam that file's own header names — so the controls
// that prove each predicate BITES belong beside the predicates rather than beside the
// tree walk. Split here on that seam when the declaration census took the claims file
// past this package's size ceiling.
//
// EVERY CASE DRIVES THE REAL PREDICATE over source parsed exactly as the walk parses a
// module, which is what makes a clean tree result mean something: a wrong node
// predicate reports no offenders over the whole console and reads identically to a
// console with none — the state the registry itself was found in, shipping for a whole
// phase with zero registrants and a green gate above it.

import { describe, expect, it } from "vitest";

import {
  airspaceRefBindings,
  backdropsMountedWithoutAirspaceRef,
  callsFunctionNamed,
  constructsClassNamed,
  declaresClassNamed,
  overlayPopupPartsMounted,
} from "./airspace-source.js";
import { parseSourceText } from "../typescript-source.js";

/** The primitive-layer hook every overlay registers through. */
const REGISTRATION_HOOK = "useAirspaceRegistration";

/** The registry accessor the hook calls, and nothing else in a view family may. */
const REGISTRY_ACCESSOR = "airspaceRegistryFor";

/** The class whose one declaration and one construction are both the holder's. */
const REGISTRY_CLASS = "AirspaceRegistry";

describe("airspace — the source predicates bite", () => {
  it("negative control: the checker bites on a planted registration", () => {
    // Without this, a wrong node predicate would leave every clean tree result in
    // the claims file meaningless — the state the registry itself was found in.
    expect(
      callsFunctionNamed(
        parseSourceText("planted.tsx", "useAirspaceRegistration('dialog');"),
        REGISTRATION_HOOK,
      ),
    ).toBe(true);
    expect(
      callsFunctionNamed(
        parseSourceText("planted.tsx", "const registry = airspaceRegistryFor(document);"),
        REGISTRY_ACCESSOR,
      ),
    ).toBe(true);
    expect(
      constructsClassNamed(
        parseSourceText("planted.tsx", "const own = new AirspaceRegistry();"),
        REGISTRY_CLASS,
      ),
    ).toBe(true);
    // The declaration is its own shape and not a construction: the second registry
    // this rule was written after was declared and exported and never built in a
    // module that ships, so a predicate that read only `new` cleared it.
    expect(
      declaresClassNamed(
        parseSourceText("planted.ts", "export class AirspaceRegistry { claim() {} }"),
        REGISTRY_CLASS,
      ),
    ).toBe(true);
  });

  it("negative control: the checker bites on a planted popup mount", () => {
    const planted = parseSourceText(
      "planted.tsx",
      'import { Dialog } from "@base-ui/react/dialog";\n' +
        "export const Planted = () => (\n" +
        "  <Dialog.Portal>\n" +
        '    <Dialog.Backdrop className="x" />\n' +
        '    <Dialog.Popup className="y">body</Dialog.Popup>\n' +
        "  </Dialog.Portal>\n" +
        ");",
    );
    expect(overlayPopupPartsMounted(planted)).toStrictEqual([
      "Dialog.Backdrop",
      "Dialog.Popup",
      "Dialog.Portal",
    ]);
    // A renamed binding mounts the same popup, and only the local name is at the tag.
    const renamed = parseSourceText(
      "renamed.tsx",
      'import { Menu as Sheet } from "@base-ui/react/menu";\n' +
        "export const Renamed = () => <Sheet.Positioner />;",
    );
    expect(overlayPopupPartsMounted(renamed)).toStrictEqual(["Sheet.Positioner"]);
  });

  it("negative control: the checker bites on a bare backdrop and clears a registered one", () => {
    // Without this pair the backdrop claim is a rule whose clean result means nothing:
    // a predicate that never fired would exonerate exactly the shape it was written
    // for, which is how the popup-only registration survived four other claims.
    const bare = parseSourceText(
      "bare.tsx",
      'import { Dialog } from "@base-ui/react/dialog";\n' +
        "export const Bare = () => (\n" +
        "  <Dialog.Portal>\n" +
        '    <Dialog.Backdrop className="x" />\n' +
        '    <Dialog.Popup className="y">body</Dialog.Popup>\n' +
        "  </Dialog.Portal>\n" +
        ");",
    );
    expect(backdropsMountedWithoutAirspaceRef(bare)).toStrictEqual(["Dialog.Backdrop"]);
    const registered = parseSourceText(
      "registered.tsx",
      'import { Dialog } from "@base-ui/react/dialog";\n' +
        "export const Registered = () => {\n" +
        '  const airspace = useModalOverlayAirspace("dialog");\n' +
        "  return (\n" +
        "    <Dialog.Portal>\n" +
        '      <Dialog.Backdrop ref={airspace.backdropRef} className="x" />\n' +
        "    </Dialog.Portal>\n" +
        "  );\n" +
        "};",
    );
    expect(backdropsMountedWithoutAirspaceRef(registered)).toStrictEqual([]);
    // The destructured form and the door hook's own single ref are the same claim
    // reached two other ways, and a rule that admitted only one shape would push the
    // next wrapper into rewriting itself to satisfy the gate.
    const destructured = parseSourceText(
      "destructured.tsx",
      'import { AlertDialog } from "@base-ui/react/alert-dialog";\n' +
        "export const Destructured = () => {\n" +
        '  const { backdropRef } = useModalOverlayAirspace("dialog");\n' +
        "  return <AlertDialog.Backdrop ref={backdropRef} />;\n" +
        "};",
    );
    expect(backdropsMountedWithoutAirspaceRef(destructured)).toStrictEqual([]);
    const doorHook = parseSourceText(
      "door-hook.tsx",
      'import { Dialog } from "@base-ui/react/dialog";\n' +
        "export const DoorHook = () => {\n" +
        '  const airspaceRef = useAirspaceRegistration("dialog");\n' +
        "  return <Dialog.Backdrop ref={airspaceRef} />;\n" +
        "};",
    );
    expect(backdropsMountedWithoutAirspaceRef(doorHook)).toStrictEqual([]);
    // A ref carrying something else is a bare backdrop as far as the airspace is
    // concerned, and the rule says so rather than accepting any attribute named `ref`.
    const foreignRef = parseSourceText(
      "foreign-ref.tsx",
      'import { Dialog } from "@base-ui/react/dialog";\n' +
        "export const ForeignRef = () => {\n" +
        "  const held = useRef(null);\n" +
        "  return <Dialog.Backdrop ref={held} />;\n" +
        "};",
    );
    expect(backdropsMountedWithoutAirspaceRef(foreignRef)).toStrictEqual(["Dialog.Backdrop"]);
    // And a backdrop from somewhere that is not the widget package is not this rule's
    // subject at all — the airspace is about what Base UI lifts out of the layout.
    const foreignFamily = parseSourceText(
      "foreign-family.tsx",
      'import { Story } from "./story.js";\nexport const Foreign = () => <Story.Backdrop />;',
    );
    expect(backdropsMountedWithoutAirspaceRef(foreignFamily)).toStrictEqual([]);
    // And the binding reader underneath all four, asserted directly: it is what
    // separates `ref={airspace.backdropRef}` from `ref={held}`, and a reader that
    // returned every `const` would clear the bare case above by accident.
    expect([...airspaceRefBindings(foreignRef)]).toStrictEqual([]);
    expect([...airspaceRefBindings(registered)]).toStrictEqual(["airspace"]);
    expect([...airspaceRefBindings(destructured)]).toStrictEqual(["backdropRef"]);
  });

  it("negative control: a sentence about the hook is not a call", () => {
    expect(
      callsFunctionNamed(
        parseSourceText(
          "explainer.ts",
          "// Overlays reach the airspace through useAirspaceRegistration(...).\nconst x = 1;",
        ),
        REGISTRATION_HOOK,
      ),
    ).toBe(false);
    expect(
      callsFunctionNamed(
        parseSourceText("explainer.ts", 'const name = "airspaceRegistryFor";'),
        REGISTRY_ACCESSOR,
      ),
    ).toBe(false);
    expect(
      constructsClassNamed(
        parseSourceText(
          "explainer.ts",
          "// The holder builds the one AirspaceRegistry.\nconst x = 1;",
        ),
        REGISTRY_CLASS,
      ),
    ).toBe(false);
    // And neither a sentence naming the class nor a type alias borrowing its name is
    // a declaration — a census that counted either would fail on every module whose
    // header explains where the airspace lives, which is most of them.
    expect(
      declaresClassNamed(
        parseSourceText(
          "explainer.ts",
          "// The floor declares AirspaceRegistry.\ntype Held = AirspaceRegistry;",
        ),
        REGISTRY_CLASS,
      ),
    ).toBe(false);
  });

  it("negative control: an in-place widget and a mention of a part are not mounts", () => {
    // The rule must not fire on the widget families that render where they stand —
    // a switch, a checkbox, a collapsible — or the primitive layer would swallow the
    // whole widget vocabulary for a hazard none of them has.
    const inPlace = parseSourceText(
      "in-place.tsx",
      'import { Collapsible } from "@base-ui/react/collapsible";\n' +
        'import { Switch } from "@base-ui/react/switch";\n' +
        "export const InPlace = () => (\n" +
        "  <Collapsible.Root>\n" +
        "    <Collapsible.Trigger>more</Collapsible.Trigger>\n" +
        "    <Collapsible.Panel>\n" +
        "      <Switch.Root />\n" +
        "    </Collapsible.Panel>\n" +
        "  </Collapsible.Root>\n" +
        ");",
    );
    expect(overlayPopupPartsMounted(inPlace)).toStrictEqual([]);
    // A part NAMED and not mounted, and a same-named tag from somewhere else.
    const mentioned = parseSourceText(
      "mentioned.tsx",
      'import { Dialog } from "@base-ui/react/dialog";\n' +
        "// The primitive mounts Dialog.Popup on this surface's behalf.\n" +
        "const part = Dialog.Popup;\n" +
        "export const Mentioned = () => <Dialog.Root>{part}</Dialog.Root>;",
    );
    expect(overlayPopupPartsMounted(mentioned)).toStrictEqual([]);
    const foreign = parseSourceText(
      "foreign.tsx",
      'import { Story } from "./story.js";\nexport const Foreign = () => <Story.Popup />;',
    );
    expect(overlayPopupPartsMounted(foreign)).toStrictEqual([]);
  });
});
