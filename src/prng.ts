// The seeded PRNG — a bit-identical port of the Daml prototype's Prng.daml.
//
// Same LCG (classic ANSI C constants), same modulus 2^31, and the same
// HIGH-BITS discipline for pick/roll: an LCG's low-order bits have a very
// short period (the lowest bit just alternates 0,1,0,1), so indexing with
// `s % n` produces badly correlated picks. Dividing by 65536 first keeps the
// well-distributed high bits. This lesson was learned the hard way in the
// PoC (the privacy loop surfaced it) — do not "simplify" it away.
//
// BigInt throughout: the multiply exceeds 2^53, so Number arithmetic would
// silently diverge from the Daml Int64 semantics and break the promise that
// a seed reproduces identically across the Daml prototypes and this tool.

const A = 1103515245n;
const C = 12345n;
const M = 2147483648n; // 2^31

export type Seed = bigint;

export const seedOf = (n: number | bigint): Seed =>
  ((BigInt(n) % M) + M) % M;

/** The next seed in the sequence. */
export const next = (s: Seed): Seed => (s * A + C) % M;

/** Roll a number in 0 .. n-1 using the seed's high bits. */
export const roll = (s: Seed, n: number): number => {
  if (n <= 0) throw new RangeError(`roll: n must be positive, got ${n}`);
  return Number((s / 65536n) % BigInt(n));
};

/** Use a seed to pick one element of a non-empty array. */
export const pick = <T>(s: Seed, xs: readonly T[]): T => {
  if (xs.length === 0) throw new RangeError("pick: empty array");
  return xs[roll(s, xs.length)];
};

/** A tiny stateful wrapper for call sites that thread seeds imperatively. */
export class Prng {
  private s: Seed;
  constructor(seed: number | bigint) {
    this.s = seedOf(seed);
  }
  /** Advance and return the new seed. */
  nextSeed(): Seed {
    this.s = next(this.s);
    return this.s;
  }
  roll(n: number): number {
    return roll(this.nextSeed(), n);
  }
  pick<T>(xs: readonly T[]): T {
    return pick(this.nextSeed(), xs);
  }
  get seed(): Seed {
    return this.s;
  }
}
