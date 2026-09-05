// The values a wire-error reader has to survive, built once for both readers.
//
// ONE HOME FOR THE ROLES BOTH SUITES PLAY, on the precedent
// `console/bridge/fixture-bridge.test-support.ts` set for the fixture bridge. These
// four were written four times under three names across `src/shared/wire-errors.test.ts`
// and `console/core/wire-rejection.test.ts`: `readableOnce` twice with different
// member sets, `revokedProxy` once as a named helper and once inline, and a third
// read-once variant beside the second copy of the first. A fixture written twice
// drifts, and these already had — one copy threw on the second reading and the other
// answered something different, which are two shapes of the same defect and are now
// one parameter.
//
// It holds nothing a single suite uses; a fixture with one reader stays beside its
// reader.
//
// WHY `src/shared/` AND NOT `test/helpers/`, where a cross-tier role would otherwise
// go. `src/renderer/tsconfig.json` is a composite project rooted at `src/`, and it
// pulls `../shared/**/*` into its program — so the leaf's own suite, which lives
// there, is inside that program too, and an import from it to `test/**` is TS6059 and
// TS6307 (measured: both, on `tsc -b`). The two readers sit in different tiers — the
// leaf's suite is `main-unit`, the console normalizer's is `console-unit` — and this
// is the only directory both can reach.
//
// It imports nothing, which is what `src/shared/` is for: the one cross-process leaf,
// compiled into both processes, whose rule is that it reaches for neither. Its only
// dependents are the two suites, which `.dependency-cruiser.mjs` removes from the
// graph before the orphan rule runs — so that rule names `.test-support.*` beside the
// declarations and stylesheets it already admits as roots.

/** A Proxy with no target left. Every prototype and property question throws. */
export function revokedProxy(): unknown {
  const revocable = Proxy.revocable({}, {});
  revocable.revoke();
  return revocable.proxy;
}

/**
 * A Proxy whose every trap throws, prototype included.
 *
 * Strictly worse than a value whose reads throw: `instanceof` asks
 * `[[GetPrototypeOf]]`, `in` asks `has`, and a spread asks `ownKeys`, so this is the
 * value that finds a guard which moved its unsafe question rather than guarding it.
 */
export function everyTrapThrows(): unknown {
  return new Proxy(
    {},
    {
      get(): never {
        throw new Error("hostile get");
      },
      getPrototypeOf(): never {
        throw new Error("hostile getPrototypeOf");
      },
      has(): never {
        throw new Error("hostile has");
      },
      ownKeys(): never {
        throw new Error("hostile ownKeys");
      },
    },
  );
}

/** A null-prototype object: `String(...)` on it throws, a total stringifier does not. */
export function nullPrototypeValue(): unknown {
  return Object.create(null) as unknown;
}

/**
 * A value whose members answer a scripted sequence of readings, and no more.
 *
 * THE SHAPE THAT MAKES A SECOND READ VISIBLE, parameterised on the members because
 * the two suites read different ones — an envelope's `code` and `message`, a
 * refusal's `code`, `detail` and `origin` — and on the answers because a second read
 * is caught two ways. One answer means the member is readable exactly once and a
 * second reading throws, which is what a returned candidate turns into: a guard reads
 * three strings and says yes, and the renderer's own read, one layer later and
 * outside every `catch`, is the throw. Several answers mean the member answers
 * something different each time, which is what catches a classifier that decided on a
 * reading it took twice.
 */
export function readableOnce(
  answersByMember: Readonly<Record<string, readonly string[]>>,
): unknown {
  const readings = new Map<string, number>();
  const value: Record<string, unknown> = {};
  for (const [member, answers] of Object.entries(answersByMember)) {
    Object.defineProperty(value, member, {
      enumerable: true,
      get(): string {
        const reading = readings.get(member) ?? 0;
        readings.set(member, reading + 1);
        const answer = answers[reading];
        if (answer === undefined) {
          throw new Error(`${member} answers ${answers.length} reading(s) and this is one more`);
        }
        return answer;
      },
    });
  }
  return value;
}
