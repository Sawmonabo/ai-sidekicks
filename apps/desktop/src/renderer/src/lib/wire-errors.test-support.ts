// Hostile and scripted values shared by the wire-error and wire-rejection suites. It holds only
// fixtures two suites use; a fixture with one reader stays beside that reader.

/** A Proxy with no target left. Every prototype and property question throws. */
export function revokedProxy(): unknown {
  const revocable = Proxy.revocable({}, {});
  revocable.revoke();
  return revocable.proxy;
}

/**
 * A Proxy whose every trap throws, prototype included. Worse than a throwing read: `instanceof`,
 * `in` and spread each hit a different trap, so it finds a guard that only moved the question.
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
 * A value whose members answer a scripted sequence of readings, and no more, so a second read is
 * visible. One answer means the member throws on a second read (what a returned candidate turns
 * into); several make it answer differently each time, catching a classifier that read twice.
 */
export function readableOnce(
  answersByMember: Readonly<Record<string, readonly unknown[]>>,
): unknown {
  const readings = new Map<string, number>();
  const value: Record<string, unknown> = {};
  for (const [member, answers] of Object.entries(answersByMember)) {
    Object.defineProperty(value, member, {
      enumerable: true,
      get(): unknown {
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
