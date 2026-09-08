// Where the console may name the `webAuthn` ceremony, and what it may hand it.
//
// WHY IT IS HERE AND NOT BESIDE THE ADAPTER. These three claims used to live in
// `console/sign-in/ceremony-adapter.test.ts`, reading the tree through a renderer-side
// `import.meta.glob("../**/*.{ts,tsx}", { query: "?raw" })`. That glob is a dependency
// EDGE, not a read: Vite's plugin resolves the pattern at transform time and knip's
// Vite plugin turns the resolved set into edges out of the importing module — and that
// module is itself a knip entry, because the `console-unit` include glob claims it. One
// suite therefore made every module under `console/` reachable, and the dead-code gate
// went silent for the whole tree: a wholly unreachable module planted at
// `console/core/knip-negative-control.ts` was reported by nothing, at rc 0, while the
// same plant under `scripts/budget/` was reported at rc 1. Measured both ways, 2026-09-08.
//
// The remedy is the one `source-parse-home.test.ts` next door already states: a gate
// that reads the tree as TEXT belongs to this tier, where the shared walk and the
// shared parse both live. Reading through `consoleSourceModules` costs no edge at all,
// because the architecture tier reads the filesystem rather than importing it.
//
// TOTAL IN BOTH DIRECTIONS, unchanged from where it was written. `deriveKeyMaterial`
// is main's, by the credential flow's own step 5 and by I-023-16, which leaves this
// renderer with no salt to derive against. A call to it from here would be this console
// choosing a PRF input — the exact trust-boundary inversion the invariant was minted to
// close — so no module in the tree may call it, exactly one module may name the
// namespace at all, and every call it makes hands the ceremony an EMPTY object.
//
// THE INSTRUMENT IS THE PARSER, and it is stronger than the regular expression it
// replaces on both halves. The caller census matched `\bsidekicks\.webAuthn\.\w+\(`
// over raw text, so a mention inside a comment counted and a call broken across lines
// did not; the argument census matched `\(\{\}\)$`, so `getAssertion({ })` — one space
// — read as a member being passed. Both are decided here on the syntax tree, where a
// comment is not a call and whitespace is not an argument.
//
// THE HONEST LIMIT. A namespace reached through a value handed in from somewhere else
// — a bound method, the namespace stored on an object — is invisible to this reading,
// the same depth limit the daemon-call census states for the door it watches. What
// closes the gap for the case that matters is that the bridge itself is reachable only
// through `bridge/BridgeProvider.tsx`, which `structure:layering` enforces.

import { beforeAll, describe, expect, it, vi } from "vitest";
import ts from "typescript";

import { ConsoleSourceTree } from "../console-source-modules.js";
import { forEachDescendant, parseSourceText } from "../typescript-source.js";

/**
 * The reading this file pays for once, and the budget it is measured against.
 *
 * The console and shell trees walked, read, and parsed once — the same shape
 * `source-parse-home.test.ts` states for the whole package, at roughly half the
 * subject. Set well above the measurement on purpose: what a budget guards is a pass
 * that never settles, not a slow one.
 */
const TREE_PARSE_ALLOWANCE_MS = 30_000;

vi.setConfig({ testTimeout: TREE_PARSE_ALLOWANCE_MS, hookTimeout: TREE_PARSE_ALLOWANCE_MS });

/** The bridge member every ceremony call is reached through. */
const BRIDGE_ROOT_MEMBER = "sidekicks";

/** The namespace this console may name from exactly one module. */
const CEREMONY_NAMESPACE = "webAuthn";

/** The derivation main owns, which no module here may call under any receiver. */
const DERIVATION_METHOD = "deriveKeyMaterial";

/** The one module admitted to name the namespace, by the walk's own display path. */
const CEREMONY_ADAPTER = "console/sign-in/ceremony-adapter.ts";

/**
 * How many modules the tree must hold for the claims below to mean anything.
 *
 * The vacuity guard the glob form carried, kept at its own number: a walk that reached
 * nothing would satisfy every case in this file by quantifying over an empty set.
 */
const CONSOLE_MODULE_FLOOR = 100;

/**
 * One module as this gate reads it: a name for a failure, and the text.
 *
 * The structural half of `ConsoleModuleText`, which satisfies it — stated here so a
 * planted control can be written as the two fields a reading actually consumes rather
 * than as a synthetic walk entry carrying two absolute paths that name nothing.
 */
interface SourceModuleText {
  readonly displayPath: string;
  readonly source: string;
}

/** One ceremony call, as the tree records it. */
interface CeremonyCall {
  readonly displayPath: string;
  readonly method: string;
  /** Whether the call's whole argument list is one empty object literal. */
  readonly passesOnlyAnEmptyObject: boolean;
}

/** The name a property access or identifier ends in, or `undefined` for anything else. */
function trailingMemberName(node: ts.Node): string | undefined {
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text;
  }
  return ts.isIdentifier(node) ? node.text : undefined;
}

/** Whether `callee` is the bridge path `….sidekicks.webAuthn.<method>`. */
function isCeremonyMember(callee: ts.PropertyAccessExpression): boolean {
  const namespace = callee.expression;
  return (
    ts.isPropertyAccessExpression(namespace) &&
    namespace.name.text === CEREMONY_NAMESPACE &&
    trailingMemberName(namespace.expression) === BRIDGE_ROOT_MEMBER
  );
}

/** Whether a call's arguments are exactly one object literal with no members. */
function passesOnlyAnEmptyObject(call: ts.CallExpression): boolean {
  const [only] = call.arguments;
  return (
    call.arguments.length === 1 &&
    only !== undefined &&
    ts.isObjectLiteralExpression(only) &&
    only.properties.length === 0
  );
}

/** Every ceremony call in one module's text, in source order. */
function ceremonyCallsIn(module: SourceModuleText): readonly CeremonyCall[] {
  const parsed = parseSourceText(module.displayPath, module.source);
  const calls: CeremonyCall[] = [];
  forEachDescendant(parsed, (node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) {
      return;
    }
    if (!isCeremonyMember(node.expression)) {
      return;
    }
    calls.push({
      displayPath: module.displayPath,
      method: node.expression.name.text,
      passesOnlyAnEmptyObject: passesOnlyAnEmptyObject(node),
    });
  });
  return calls;
}

/**
 * Every module that CALLS the derivation, under any receiver at all.
 *
 * Asked of the call and not of the word, because the adapter's own header names the
 * method to explain why it never calls it — which the text needle this replaces could
 * not tell apart from a caller.
 */
function derivationCallers(modules: readonly SourceModuleText[]): readonly string[] {
  return modules
    .filter((module) => {
      const parsed = parseSourceText(module.displayPath, module.source);
      let calls = false;
      forEachDescendant(parsed, (node) => {
        if (
          ts.isCallExpression(node) &&
          trailingMemberName(node.expression) === DERIVATION_METHOD
        ) {
          calls = true;
        }
      });
      return calls;
    })
    .map((module) => module.displayPath);
}

const tree = new ConsoleSourceTree();

describe("what this console may never name — the sign-in ceremony", () => {
  beforeAll(() => {
    tree.read();
  });

  it("calls the ceremony from the adapter and nowhere else in the tree", () => {
    expect(tree.reading.modules.length).toBeGreaterThan(CONSOLE_MODULE_FLOOR);
    const callers = tree.reading.texts
      .filter((module) => ceremonyCallsIn(module).length > 0)
      .map((module) => module.displayPath);
    expect(callers).toStrictEqual([CEREMONY_ADAPTER]);
  });

  it("passes the ceremony nothing this renderer chose", () => {
    // I-023-16 in its own terms: the untrusted renderer supplies no challenge, no
    // relying-party identifier, and no PRF salt. The preload stub's option types are
    // empty interfaces, so an empty object literal is the whole admissible argument —
    // and a member added to one of those calls is what this case is watching for,
    // which the claim above cannot see at all.
    const calls = tree.reading.texts.flatMap(ceremonyCallsIn);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter((call) => !call.passesOnlyAnEmptyObject)).toStrictEqual([]);
  });

  it("calls the PRF derivation from nowhere at all", () => {
    expect(derivationCallers(tree.reading.texts)).toStrictEqual([]);
  });

  it("negative control: both readings report a planted caller and clear a mention", () => {
    // Without this the three cases above report clean over any tree whose call shape
    // the parse stopped recognising, which is the failure this class of gate is most
    // prone to. Every planted module is a shape the real tree does not carry.
    const planted: readonly SourceModuleText[] = [
      {
        displayPath: "console/settings/settings-sign-in.ts",
        source: [
          "export async function signInFromSettings(bridge: ConsoleBridge): Promise<void> {",
          "  await bridge.sidekicks.webAuthn.getAssertion({ challenge: chosenHere });",
          "}",
        ].join("\n"),
      },
      {
        displayPath: "console/sign-in/ceremony-notes.ts",
        // A mention and never a call: the word in prose, and the member named on a
        // fixture's own object literal. The text needle this replaces read both.
        source: [
          "// Main owns deriveKeyMaterial( and this console never calls it.",
          "export const stub = { deriveKeyMaterial: undefined };",
        ].join("\n"),
      },
    ];

    const plantedCalls = planted.flatMap(ceremonyCallsIn);
    expect(plantedCalls.map((call) => call.displayPath)).toStrictEqual([
      "console/settings/settings-sign-in.ts",
    ]);
    expect(plantedCalls.map((call) => call.method)).toStrictEqual(["getAssertion"]);
    expect(plantedCalls.filter((call) => !call.passesOnlyAnEmptyObject)).toHaveLength(1);
    expect(derivationCallers(planted)).toStrictEqual([]);
  });

  it("negative control: the derivation reading names a real call under any receiver", () => {
    const planted: readonly SourceModuleText[] = [
      {
        displayPath: "console/sign-in/local-derivation.ts",
        source: "export const key = await bridge.sidekicks.webAuthn.deriveKeyMaterial({});\n",
      },
    ];

    expect(derivationCallers(planted)).toStrictEqual(["console/sign-in/local-derivation.ts"]);
  });
});
