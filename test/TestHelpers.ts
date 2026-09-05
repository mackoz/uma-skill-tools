import * as fc from 'fast-check';

export function forAll<Ts extends [unknown, ...unknown[]]>(
	...args: [...arbs: { [K in keyof Ts]: fc.Arbitrary<Ts[K]> }, pred: (...args: Ts) => boolean | void]
) {
	return () => fc.assert(fc.property(...args));
}
