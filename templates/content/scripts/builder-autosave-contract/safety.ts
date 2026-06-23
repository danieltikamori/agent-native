/**
 * Safety guards for the Builder autosave contract harness.
 *
 * NON-NEGOTIABLE: this harness may only ever create and mutate brand-new,
 * clearly-named throwaway entries that it created within the same run. It must
 * never touch pre-existing content. These guards enforce that at the code
 * level so a mistake throws instead of mutating real content.
 */

/** Every throwaway entry this harness creates carries this prefix in its name. */
export const THROWAWAY_PREFIX = "zz-autosave-contract-test";

export interface RunFlags {
  /** Actually hit the Builder API. Without this, the harness only prints a plan. */
  live: boolean;
  /** Allow the destructive `published:"draft"` (unpublish) probe — Q3. */
  allowUnpublishTest: boolean;
  /** Builder model to create the throwaway entry in (default: a test model). */
  model: string;
}

export function parseFlags(argv: string[]): RunFlags {
  const has = (flag: string) => argv.includes(flag);
  const valueOf = (flag: string): string | undefined => {
    const eq = argv.find((a) => a.startsWith(`${flag}=`));
    if (eq) return eq.slice(flag.length + 1);
    const idx = argv.indexOf(flag);
    if (idx >= 0 && idx + 1 < argv.length && !argv[idx + 1].startsWith("--")) {
      return argv[idx + 1];
    }
    return undefined;
  };
  return {
    live: has("--live"),
    allowUnpublishTest: has("--allow-unpublish-test"),
    model: valueOf("--model") ?? "zz-autosave-contract-test-model",
  };
}

/** A registry of entry IDs this run created. Only these may be mutated. */
export class ThrowawayRegistry {
  private readonly ids = new Set<string>();
  private readonly names = new Map<string, string>();

  register(id: string, name: string): void {
    if (!isThrowawayName(name)) {
      throw new Error(
        `Refusing to register entry "${id}" — name ${JSON.stringify(
          name,
        )} does not carry the throwaway prefix ${THROWAWAY_PREFIX}.`,
      );
    }
    this.ids.add(id);
    this.names.set(id, name);
  }

  /**
   * Assert an id is safe to mutate. Throws unless the id was created by THIS
   * run AND its registered name carries the throwaway prefix. This is the
   * single chokepoint every mutating call must pass through.
   */
  assertMutable(id: string, operation: string): void {
    if (!this.ids.has(id)) {
      throw new Error(
        `SAFETY ABORT: refusing ${operation} on entry "${id}" — it was not ` +
          `created by this harness run. The harness may only mutate its own ` +
          `throwaway entries.`,
      );
    }
    const name = this.names.get(id) ?? "";
    if (!isThrowawayName(name)) {
      throw new Error(
        `SAFETY ABORT: refusing ${operation} on entry "${id}" — its name ` +
          `${JSON.stringify(name)} lacks the throwaway prefix.`,
      );
    }
  }

  list(): { id: string; name: string }[] {
    return [...this.ids].map((id) => ({ id, name: this.names.get(id) ?? "" }));
  }
}

export function isThrowawayName(name: string | undefined): boolean {
  return typeof name === "string" && name.startsWith(THROWAWAY_PREFIX);
}

export function makeThrowawayName(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 8);
  return `${THROWAWAY_PREFIX}-${stamp}-${rand}`;
}
