/**
 * Equivalence tests for the local Web Crypto helper.
 *
 * `sha256Base64UrlNoPad` replaced an import of `@better-auth/utils`, which this
 * package never declared. The replacement is only safe if it is byte-identical:
 * the value is the database lookup key `@better-auth/oauth-provider` computes
 * for `storeTokens: "hashed"`, so a one-bit difference means every token lookup
 * misses.
 *
 * `@better-auth/utils` is the *correct* reference for this particular value,
 * and that is a deliberate claim rather than an assumption. oauth-provider's
 * `defaultHasher` (read at `@better-auth/oauth-provider@1.7.2`,
 * `dist/utils-C2yu_zRr.mjs:420-422`) is literally:
 *
 * ```js
 * const hash = await createHash("SHA-256").digest(new TextEncoder().encode(value));
 * return base64Url.encode(new Uint8Array(hash), { padding: false });
 * ```
 *
 * Contrast the session cookie, where `@better-auth/utils` was *not* the right
 * reference and an equivalence suite like this one passed while the cookie was
 * rejected — see `../server/session-cookie.test.ts`. Matching a utility only
 * proves anything once you have checked that the consumer uses that utility.
 *
 * `@better-auth/utils` is imported here as a **devDependency** — it is the
 * reference implementation under test, and it is deliberately not part of the
 * shipped dependency graph.
 */

import { describe, expect, test } from "bun:test";
import { base64Url } from "@better-auth/utils/base64";
import { createHash } from "@better-auth/utils/hash";

import { base64UrlEncodeNoPad, sha256Base64UrlNoPad } from "./webcrypto.js";

/** Deterministic PRNG so a failure is reproducible from the seed alone. */
function makeRandom(seed: number) {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state & 0xff;
	};
}

function randomBytes(length: number, seed: number): Uint8Array {
	const next = makeRandom(seed);
	return Uint8Array.from({ length }, () => next());
}

describe("the reference implementation under test", () => {
	// The equivalence proof is only meaningful against the version of
	// `@better-auth/utils` that `better-auth` actually resolves. Pinning the
	// devDependency exactly is not enough on its own — if Better Auth moves to a
	// new utils release, this assertion fails and the reference gets refreshed
	// rather than silently drifting.
	test("is pinned to the exact version @better-auth/core peers", async () => {
		const repo = new URL("../../", import.meta.url);
		const manifest = (await Bun.file(new URL("package.json", repo)).json()) as {
			devDependencies?: Record<string, string>;
		};
		const core = (await Bun.file(
			new URL("node_modules/@better-auth/core/package.json", repo),
		).json()) as { peerDependencies?: Record<string, string> };

		expect(manifest.devDependencies?.["@better-auth/utils"]).toBe(
			core.peerDependencies?.["@better-auth/utils"] ?? "<missing>",
		);
	});
});

describe("base64UrlEncodeNoPad", () => {
	// Lengths 0..2 mod 3 are the three padding cases; the loop covers all of
	// them repeatedly, which is where a naive btoa+strip implementation breaks.
	test("matches @better-auth/utils across every input length 0-64", () => {
		for (let length = 0; length <= 64; length++) {
			const bytes = randomBytes(length, length + 1);
			expect(base64UrlEncodeNoPad(bytes)).toBe(
				base64Url.encode(bytes, { padding: false }),
			);
		}
	});

	test("emits no padding and only the URL-safe alphabet", () => {
		for (let length = 1; length <= 32; length++) {
			const encoded = base64UrlEncodeNoPad(randomBytes(length, length * 7));
			expect(encoded).not.toContain("=");
			expect(encoded).not.toContain("+");
			expect(encoded).not.toContain("/");
			expect(encoded).toMatch(/^[A-Za-z0-9_-]*$/);
		}
	});

	test("round-trips through the reference decoder", () => {
		const bytes = randomBytes(48, 99);
		expect(Array.from(base64Url.decode(base64UrlEncodeNoPad(bytes)))).toEqual(
			Array.from(bytes),
		);
	});
});

describe("sha256Base64UrlNoPad", () => {
	const reference = async (value: string) => {
		const hash = await createHash("SHA-256").digest(
			new TextEncoder().encode(value),
		);
		return base64Url.encode(new Uint8Array(hash), { padding: false });
	};

	const inputs = [
		"",
		"a",
		"sigma",
		`ory_at_${"x".repeat(43)}`,
		"unicode: éü中文 \u{1f510}",
		randomBytes(200, 5).join(","),
	];

	for (const value of inputs) {
		test(`matches the previous @better-auth/utils output for ${JSON.stringify(value.slice(0, 24))}`, async () => {
			expect(await sha256Base64UrlNoPad(value)).toBe(await reference(value));
		});
	}
});
