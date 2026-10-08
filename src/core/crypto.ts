// Small crypto helpers shared by the Worker and the core.

/** Constant-time string compare (no early exit; length difference folded in). */
export const same = (a: string, b: string) => {
	const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
	let d = x.length ^ y.length;
	for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
	return d === 0;
};

export const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
