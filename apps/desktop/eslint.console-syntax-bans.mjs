// The console's single-reading chokepoints, enforced as SYNTAX.
//
// A SIBLING OF THE FLAT CONFIG, not a second config: `eslint.config.mjs` spreads the one
// export below into its own array, so there is still exactly one place a reviewer reads
// to know what the console may not write. It lives here because the bans and their
// derivations had grown past the point where the import boundary above them was still
// findable in the same file — the package's own rule is that a file over about 400 lines
// is doing two jobs, and the import boundary and the syntax bans are two.
//
// Everything the block needs to say about itself is said in the block. Nothing else in
// the package imports this module.

/**
 * How the corpus spells a WIRE instant, as a regular-expression source.
 *
 * One declaration for every selector below that keys on the name of a stamp, because
 * the alternative is the same suffix written five times and drifting on the day a
 * sixth spelling arrives.
 */
const WIRE_STAMP_NAME_SUFFIX = "(?:At|Iso)$";

/**
 * How the console spells a NUMERIC instant — the one construction `new Date(...)`
 * leaves open.
 *
 * A census of this tree rather than a convention, which is what the arm it serves was
 * missing: the only bare name any `new Date(...)` under `console/` passes today is
 * `sequence`, a fixture counter, and the millisecond and epoch suffixes are how the
 * corpus spells a numeric instant everywhere it composes one
 * (`ATTENTION_SCENARIO_STARTED_AT_MILLISECONDS + atMs`). A name outside this set is
 * refused, which is the opposite of the heuristic that stood here and could not see
 * `new Date(iso)`.
 *
 * BOTH OF THE CORPUS'S TWO NAMING CONVENTIONS, and the second half was missing until
 * the block reached the test tiers. The census above was taken over `src/`, where
 * every `new Date(...)` argument happened to be a camelCase local — and the very
 * constant this comment cites as the corpus's own spelling, a module-level
 * SCREAMING_SNAKE name, could not have satisfied it. It never fired only because that
 * one appears inside a sum, which is a binary expression and not a name. So a tier
 * file naming its instant the way this package names every module constant was
 * refused for the naming convention rather than for the reading, which is a false
 * alarm of exactly the kind that gets a ban switched off.
 */
const NUMERIC_INSTANT_NAME_SUFFIX =
  "(?:Ms|Milliseconds|Epoch|[Ss]equence|_MS|_MILLISECONDS|_EPOCH)$";

/** The one `no-restricted-syntax` invocation the package makes. */
export const consoleSyntaxBans = [
  // The console's two single-reading chokepoints, enforced as SYNTAX because they are
  // not import bans and `no-restricted-imports` cannot express any of them. This is the
  // package's first and only `no-restricted-syntax` invocation: flat config replaces a
  // rule's options at the LAST matching config object, so a later block that also
  // configures this rule for any file under `console/` or `shell/` must restate every
  // selector below rather than add to them.
  //
  // ONE MORE SELECTOR LIVED HERE AND IS GONE — count-free on purpose, since the list
  // grows. It banned importing
  // `normalizeWireRejection` from `src/shared/wire-errors.ts`, back when a function of
  // that name lived in both that module and `console/core/wire-rejection.ts` with two
  // different return types — an import from the wrong one compiled wherever the result
  // was only rendered. The shared function is now `wireRejectionToError`, named for
  // what it answers, so the collision is closed at its source. What the selector used
  // to catch, `tsc` now catches first and better: the stale import is
  // `error TS2305: Module ... has no exported member 'normalizeWireRejection'`
  // (measured against the real typecheck script, not assumed). A lint rule whose only
  // reachable target is a symbol that does not exist guards nothing.
  //
  // THE TWO CATCH-STRINGIFICATION SELECTORS LIVED HERE AND ARE GONE, replaced by
  // `test/console/architecture/catch-stringification-chokepoint.test.ts`. They banned
  // `String(...)` inside a `CatchClause` and an interpolated catch binding, and they
  // reached four of the eight spellings the same ToPrimitive is written in: the template
  // arm was keyed on the two binding NAMES this tree happens to use, so a third name
  // reached neither arm, and `"" + error`, `error.toString()`, and every `.catch((e) =>
  // …)` form are not inside a `CatchClause` at all. esquery has no backreference, so a
  // selector cannot bind a catch parameter and compare it to the identifier being
  // stringified — which is why the honest instrument for that claim is source text over
  // the shared console walk, the same one the timer and byte-scaling chokepoints use.
  // A selector that catches half a class reads exactly like one that catches the class.
  //
  // Scope is `console/**` and `shell/**`, tests included. `shell/**` matches nothing on
  // this branch and is named anyway: it is a `console-unit` resident by
  // `apps/desktop/AGENTS.md`, and a gate that arrives after the code it governs arrives
  // too late. A `files` pattern matching no file is not an ESLint error.
  //
  // EVERY EXEMPTION EARNS ITSELF, and the earning is mechanical rather than argued:
  // `test/console/architecture/eslint-exemption-census.test.ts` resolves this block's
  // exempt set out of the real engine and lints each exempt file's own text at a
  // NON-exempt path, requiring the selectors to bite. An entry whose file no longer
  // writes the thing it was excused for fails that gate, so an exemption cannot outlive
  // its cause.
  //
  // The two that remain are the negative controls, which have to CALL the banned API to
  // demonstrate that `Date.parse` answers a number for a value RFC 3339 refuses. A ban
  // nobody can show the cost of is a ban nobody keeps.
  //
  // TWO MORE WERE LISTED HERE AND NEITHER WAS EARNED. `core/clock.ts` was excused as the
  // console's one `Date.now` seam — but `Date.now` matches no selector above, so the
  // entry excused a file from rules it never broke. `core/wire-rejection.ts` was excused
  // as the reading the `String(catch)` rule points at — and it names `String(...)` in its
  // prose only, never in a `catch`. Both lint clean without an entry, which is how the
  // census establishes it rather than by this comment saying so. What they cost while
  // they sat here is the real thing: an exempt file is exempt from EVERY selector, so a
  // `Date.parse` or a template-interpolated catch binding could have landed in either one
  // and the gate would have stayed green.
  {
    files: [
      "src/renderer/src/console/**/*.{ts,tsx}",
      "src/renderer/src/shell/**/*.{ts,tsx}",
      // THE TIERS, and their absence was how the two `Date.parse` calls a family
      // adversarial review removed got in. A test reads the same wire stamps the
      // console does, and a fixture composed with `Date.parse` records the HOST's
      // zone into an expectation the surface under test is then measured against —
      // which is the same defect as the production one, arriving through the file
      // that is supposed to catch it. Nothing here is exempt: the two negative
      // controls that must call the banned API sit under `src/` and are named in
      // `ignores` by path, so a tier file cannot inherit their exemption.
      "test/console/**/*.{ts,tsx}",
    ],
    ignores: [
      "src/renderer/src/console/core/instant.test.ts",
      "src/renderer/src/console/primitives/wire-figures.time.test.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          // The REFERENCE, not only the call. `Date.parse(iso)` is the spelling this ban
          // was written against, and three more reach the same function without ever
          // writing those two names in that order — measured passing the call-keyed
          // selector this replaces: a destructure (`const { parse } = Date; parse(iso)`),
          // a computed key (`Date["parse"](iso)`), and a read through the global object
          // (`globalThis.Date.parse(iso)`). Keying on the member READ catches the value
          // wherever it is taken rather than only where it is invoked.
          //
          // The destructuring arm is written against the PATTERN because that shape has
          // no member read at all: it names `Date` as an initialiser and takes whatever
          // it likes off it. It therefore refuses `const { now } = Date` too, which is
          // deliberate — `core/clock.ts` is the console's one time seam and reaches
          // `Date.now` through the object.
          selector: `:matches(MemberExpression[object.name="Date"][property.name="parse"], MemberExpression[object.name="Date"][property.value="parse"], MemberExpression[object.property.name="Date"][property.name="parse"], MemberExpression[object.property.name="Date"][property.value="parse"], VariableDeclarator[init.name="Date"] > ObjectPattern)`,
          message:
            "`Date.parse` is not a validator: it reads a timezone-less stamp in the HOST's zone, reads a date-only string in UTC, and normalizes a day that does not exist (`2026-02-30T10:00:00Z` becomes March 2). Each answers a NUMBER, so the `Number.isNaN` guard passes and a surface renders an instant the wire never sent. Read the stamp with `parseInstant` from `console/core/instant.ts`, and order two of them with `compareInstants`. Taking the function off `Date` by a destructure, a computed key, or the global object reaches the same reading.",
        },
        {
          // A string-shaped argument only. `new Date(<milliseconds>)` is how a fixture
          // composes an instant from a base and an offset and stays legitimate; a
          // numeric literal can carry none of `-`, `:`, or `T`, and a negative one is a
          // `UnaryExpression` rather than a `Literal`, so neither matches.
          selector:
            'NewExpression[callee.name="Date"] > :matches(TemplateLiteral, Literal[value=/[-:T]/])',
          message:
            "`new Date(<string>)` is `Date.parse` with a wrapper and carries the same leniency. Read the stamp with `parseInstant` from `console/core/instant.ts`; build a fixture instant from `Date.UTC(...)` instead of parsing one.",
        },
        {
          // The NAMED form, INVERTED. This arm used to key on the argument's NAME being
          // stamp-shaped — `…At` or `…Iso` — and justified itself with "the corpus spells
          // every wire instant that way". The console's own figure chokepoint refutes it:
          // `formatClockTime(iso: string)` in `primitives/wire-figures.ts` carries a wire
          // stamp under a lower-case name, and `new Date(iso)` there passed the check.
          // A premise a live call site in the same tree contradicts is not a convention.
          //
          // So the ban is stated the other way round: a `new Date` whose argument is a
          // NAME is refused unless the name says it is a number. That inverts which side
          // pays for a spelling nobody anticipated — a new stamp name is caught, and a
          // new numeric name is a one-word edit to `NUMERIC_INSTANT_NAME_SUFFIX` that a
          // reviewer sees. A sum or a call is not a name and is outside the arm entirely,
          // so `new Date(base + offsetMs)` and `new Date(Date.UTC(...))` still pass.
          selector: `:matches(NewExpression[callee.name="Date"][arguments.0.type="Identifier"][arguments.0.name!=/${NUMERIC_INSTANT_NAME_SUFFIX}/], NewExpression[callee.name="Date"][arguments.0.type="MemberExpression"][arguments.0.property.name!=/${NUMERIC_INSTANT_NAME_SUFFIX}/])`,
          message:
            "`new Date(<a named value>)` is `Date.parse` with a wrapper and carries the same leniency — it just does not look like it, because the string is behind a name. Read the stamp with `parseInstant` from `console/core/instant.ts`; build a fixture instant from `Date.UTC(...)`, or name the value for the number it holds (`…Ms`, `…Milliseconds`, `…Epoch`).",
        },
        {
          // Ordering two stamps by their TEXT. `compareInstants` exists because the wire's
          // stamps are not lexically ordered: an offset form and a `Z` form naming the same
          // moment differ, and `2026-01-01T00:00:00+01:00` sorts AFTER `2026-01-01T00:00:00Z`
          // while naming an EARLIER one — `core/instant.ts` states that in its own header and
          // its suite asserts it. A list sorted this way is not approximately right; it is
          // wrong at exactly the rows whose order a reader would check.
          //
          // The CALL is the match and the stamp is looked for ANYWHERE inside it, which is
          // what the four operand-keyed selectors this replaces could not do: they required
          // the receiver and the argument to be an identifier or a member, so
          // `(row.touchedAt ?? "").localeCompare(...)` — a `LogicalExpression` receiver, and
          // what a caller writes for a `string | undefined` stamp — passed, and so did
          // `String(row.touchedAt).localeCompare(...)`. Both were measured.
          //
          // `localeCompare` on anything else is untouched: sorting a display path, a repo
          // name, or a participant handle is what it is for.
          selector: `CallExpression[callee.property.name="localeCompare"]:has(:matches(MemberExpression[property.name=/${WIRE_STAMP_NAME_SUFFIX}/], Identifier[name=/${WIRE_STAMP_NAME_SUFFIX}/]))`,
          message:
            "Two RFC 3339 stamps are not lexically ordered: an offset form and a `Z` form naming the same moment differ, and a `+01:00` stamp sorts AFTER the `Z` stamp it PRECEDES. Order them with `compareInstants` from `console/core/instant.ts`, which compares the moments; `localeCompare` on a name, a path, or a handle is untouched.",
        },
        {
          // The SHORTER spelling of the same defect, which `core/instant.ts` names in the
          // same breath as `localeCompare` ("`localeCompare`, `<`, `>`") and which nothing
          // banned: `<` is what a comparator reaches for first.
          //
          // BOTH SIDES have to name a stamp, and that is precision rather than caution.
          // This tree carries two `…At` figures that are NUMBERS — `dueAt` on the frozen
          // clock's entries (`core/clock.ts`) and `updatedAt` on a persistence record
          // (`persistence/adapter.ts`) — and both are compared against a plain identifier
          // (`entry.dueAt <= target`, `entry.updatedAt < oldestUpdatedAt`). A one-sided
          // name key would fail those two, and a ban whose first two findings are false is
          // a ban somebody turns off. The comparator shape the defect actually takes names
          // the stamp on both sides.
          //
          // The third arm is the wrapped form, one side being enough there: a stamp reached
          // through `?? ""` or `String(...)` inside a comparison is a stamp being ordered
          // as text whatever sits opposite it, and no numeric figure in this tree is
          // written that way. It is keyed on the DIRECT child so a comparison that merely
          // contains a stamp somewhere — `rows.filter((row) => row.createdAt).length > 0` —
          // is not swept in.
          selector: `:matches(BinaryExpression[operator=/^[<>]=?$/][left.property.name=/${WIRE_STAMP_NAME_SUFFIX}/][right.property.name=/${WIRE_STAMP_NAME_SUFFIX}/], BinaryExpression[operator=/^[<>]=?$/][left.name=/${WIRE_STAMP_NAME_SUFFIX}/][right.name=/${WIRE_STAMP_NAME_SUFFIX}/], BinaryExpression[operator=/^[<>]=?$/]:has(> :matches(LogicalExpression, CallExpression):has(:matches(MemberExpression[property.name=/${WIRE_STAMP_NAME_SUFFIX}/], Identifier[name=/${WIRE_STAMP_NAME_SUFFIX}/]))))`,
          message:
            "Ordering two RFC 3339 stamps with `<` or `>` compares their TEXT: an offset form and a `Z` form naming the same moment differ, and a `+01:00` stamp sorts AFTER the `Z` stamp it PRECEDES. Order them with `compareInstants` from `console/core/instant.ts`, which compares the moments; comparing two numeric figures is untouched.",
        },
      ],
    },
  },
];
