import Prando from 'prando';

export interface PRNG {
	int32(): number
	random(): number
	uniform(upper: number): number
}

/** Derive a stable 32-bit seed without consuming another random stream. */
export function deriveSeed(seed: number, key: string): number {
	let hash = (seed ^ 0x811c9dc5) >>> 0;
	for (let i = 0; i < key.length; ++i) {
		hash ^= key.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	// MurmurHash3 finalizer; avoids weak seeds for similar skill IDs.
	hash ^= hash >>> 16;
	hash = Math.imul(hash, 0x85ebca6b) >>> 0;
	hash ^= hash >>> 13;
	hash = Math.imul(hash, 0xc2b2ae35) >>> 0;
	return (hash ^ (hash >>> 16)) >>> 0;
}

export class SeededRng {
	private prando: Prando;

	constructor(seed: number) {
		this.prando = new Prando(seed);
	}

	int32(): number {
		return Math.floor(this.prando.next() * 0x100000000);
	}

	random(): number {
		return this.prando.next();
	}

	uniform(upper: number): number {
		return this.prando.nextInt(0, upper - 1);
	}
}

export const Rule30CARng = SeededRng;
