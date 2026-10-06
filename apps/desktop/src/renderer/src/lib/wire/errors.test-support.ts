// Hostile values shared by the wire-error, wire-rejection and refusal-extension suites. It holds
// only fixtures two suites use; a fixture with one reader stays beside that reader.

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
