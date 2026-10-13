// The import lines one generated module needs, gathered while its parts are written, so each
// name is imported once and a name that would clash with one the module declares is refused.
import { posix } from "node:path";

/** A type or check named by a method table: a definition of this module or `<module>#<Name>`. */
export interface TypeReference {
  /** The owning module's path, or undefined for a definition of the module being written. */
  readonly module: string | undefined;
  readonly name: string;
}

/** Reads `Name` or `<module>#<Name>`; a reference to the module itself reads as local. */
export function parseTypeReference(reference: string, currentModule: string): TypeReference {
  const [module, name] = reference.includes("#") ? reference.split("#") : [undefined, reference];
  if (name === undefined) {
    throw new Error(`type reference ${JSON.stringify(reference)} has no name`);
  }
  return { module: module === currentModule ? undefined : module, name };
}

/** The import specifier from `fromModule`'s file to `toModule`'s, both module paths. */
export function moduleSpecifier(fromModule: string, toModule: string): string {
  const relative = posix.relative(posix.dirname(fromModule), toModule);
  return `${relative.startsWith(".") ? relative : `./${relative}`}.js`;
}

/** The imports of one generated module, rendered sorted by specifier. */
export class ModuleImports {
  private readonly named = new Map<string, Map<string, "type" | "value">>();
  private readonly defaults = new Map<string, string>();
  private readonly owners = new Map<string, string>();
  private readonly modulePath: string;
  private readonly localNames: ReadonlySet<string>;

  constructor(modulePath: string, localNames: ReadonlySet<string>) {
    this.modulePath = modulePath;
    this.localNames = localNames;
  }

  /** Imports `name` from another contract module, as a type only unless `kind` is `value`. */
  addFromModule(module: string, name: string, kind: "type" | "value"): void {
    this.addNamed(moduleSpecifier(this.modulePath, module), name, kind);
  }

  /** Imports `name` from a package or a hand-written module given by its specifier. */
  addNamed(specifier: string, name: string, kind: "type" | "value"): void {
    this.claim(name, specifier);
    const names = this.named.get(specifier) ?? new Map<string, "type" | "value">();
    names.set(name, names.get(name) === "value" ? "value" : kind);
    this.named.set(specifier, names);
  }

  /** Imports a module's default export as `localName`. */
  addDefault(specifier: string, localName: string): void {
    this.claim(localName, specifier);
    this.defaults.set(specifier, localName);
  }

  /** The import statements, one per specifier. */
  render(): string {
    const specifiers = [...new Set([...this.defaults.keys(), ...this.named.keys()])].sort();
    return specifiers
      .map((specifier) => {
        const defaultName = this.defaults.get(specifier);
        const entries = [
          ...(this.named.get(specifier) ?? new Map<string, "type" | "value">()),
        ].sort(([left], [right]) => (left < right ? -1 : 1));
        // A type-only import is erased whole; a mixed one marks each type, so neither loads
        // a module for a type alone.
        const typesOnly = defaultName === undefined && entries.every(([, kind]) => kind === "type");
        const names = entries.map(([name, kind]) =>
          kind === "type" && !typesOnly ? `type ${name}` : name,
        );
        const parts = [
          ...(defaultName === undefined ? [] : [defaultName]),
          ...(names.length === 0 ? [] : [`{ ${names.join(", ")} }`]),
        ];
        return `import ${typesOnly ? "type " : ""}${parts.join(", ")} from "${specifier}";`;
      })
      .join("\n");
  }

  private claim(name: string, specifier: string): void {
    if (this.localNames.has(name)) {
      throw new Error(`${this.modulePath}: imported ${name} clashes with a local name`);
    }
    const owner = this.owners.get(name);
    if (owner !== undefined && owner !== specifier) {
      throw new Error(
        `${this.modulePath}: ${name} would be imported from ${owner} and ${specifier}`,
      );
    }
    this.owners.set(name, specifier);
  }
}
