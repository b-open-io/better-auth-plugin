/**
 * End-to-end proof that the session cookie this package writes is one Better
 * Auth will actually accept.
 *
 * These tests deliberately do **not** compare against a crypto utility. That is
 * how the defect they cover survived: `/payload` signed with
 * `createHMAC("SHA-256", "base64urlnopad")`, an equivalence suite proved the
 * replacement matched it byte for byte, and every assertion passed while the
 * cookie was rejected on the very next request. The only reference that means
 * anything here is Better Auth's own session verification, so that is what is
 * exercised — a real `betterAuth()` instance, a real session row, and
 * `auth.api.getSession()` reading the cookie back.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";

import {
	SESSION_COOKIE_SIGNATURE_LENGTH,
	SESSION_COOKIE_SIGNATURE_SUFFIX,
	signSessionCookieValue,
} from "./session-cookie.js";

const SECRET = "test-secret-value-at-least-32-chars-long";

type Store = Record<string, Array<Record<string, unknown>>>;

/**
 * Wrapped so TypeScript keeps `betterAuth`'s precisely inferred instance type;
 * annotating with the bare `ReturnType<typeof betterAuth>` widens the options
 * generic and no longer matches.
 */
function createTestAuth() {
	const db: Store = { user: [], account: [], session: [], verification: [] };
	return betterAuth({
		database: memoryAdapter(db),
		secret: SECRET,
		baseURL: "http://localhost:3000",
	});
}

let auth: ReturnType<typeof createTestAuth>;
let cookieName: string;
let sessionToken: string;

beforeAll(async () => {
	auth = createTestAuth();

	const ctx = await auth.$context;
	cookieName = ctx.authCookies.sessionToken.name;

	const user = await ctx.adapter.create<{ id: string }>({
		model: "user",
		data: {
			email: "cookie@example.test",
			name: "Cookie",
			emailVerified: true,
			createdAt: new Date(),
			updatedAt: new Date(),
		},
	});
	const session = await ctx.internalAdapter.createSession(user.id);
	if (!session?.token) throw new Error("failed to create a session fixture");
	sessionToken = session.token;
});

/** Reads a cookie value back through Better Auth's real verification path. */
async function readSession(cookieValue: string) {
	return auth.api.getSession({
		headers: new Headers({
			cookie: `${cookieName}=${encodeURIComponent(cookieValue)}`,
		}),
	});
}

describe("signSessionCookieValue", () => {
	test("produces a signature better-call's gate will accept", async () => {
		const value = await signSessionCookieValue(sessionToken, SECRET);
		const signature = value.slice(value.lastIndexOf(".") + 1);

		// better-call/dist/context.mjs, verbatim:
		//   if (signature.length !== 44 || !signature.endsWith("=")) return null;
		expect(signature).toHaveLength(SESSION_COOKIE_SIGNATURE_LENGTH);
		expect(signature.endsWith(SESSION_COOKIE_SIGNATURE_SUFFIX)).toBe(true);
		// Padded *standard* Base64, so `+` and `/` are legal and `-`/`_` are not.
		expect(signature).toMatch(/^[A-Za-z0-9+/]+=$/);
	});

	test("keeps the token intact as the value before the final dot", async () => {
		const value = await signSessionCookieValue(sessionToken, SECRET);
		expect(value.slice(0, value.lastIndexOf("."))).toBe(sessionToken);
	});

	test("Better Auth accepts the cookie and returns the session", async () => {
		const value = await signSessionCookieValue(sessionToken, SECRET);
		const result = await readSession(value);

		expect(result).not.toBeNull();
		expect(result?.session.token).toBe(sessionToken);
		expect(result?.user.email).toBe("cookie@example.test");
	});

	test("a signature made with the wrong secret is rejected", async () => {
		const value = await signSessionCookieValue(
			sessionToken,
			"a-different-secret",
		);
		expect(await readSession(value)).toBeNull();
	});

	test("an unsigned token is rejected", async () => {
		expect(await readSession(sessionToken)).toBeNull();
	});
});

describe("regression: base64url signatures are rejected", () => {
	/** The encoding `/payload` used to emit: base64url, unpadded. */
	async function base64UrlNoPadSignature(token: string, secret: string) {
		const encoder = new TextEncoder();
		const key = await crypto.subtle.importKey(
			"raw",
			encoder.encode(secret),
			{ name: "HMAC", hash: { name: "SHA-256" } },
			false,
			["sign"],
		);
		const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(token));
		return btoa(String.fromCharCode(...new Uint8Array(mac)))
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");
	}

	test("the old encoding fails the length and padding gate", async () => {
		const signature = await base64UrlNoPadSignature(sessionToken, SECRET);
		expect(signature).toHaveLength(43);
		expect(signature.endsWith("=")).toBe(false);
	});

	// The assertion that would have caught the shipped bug. It is the same
	// secret and the same token as the passing case above — only the encoding
	// differs, and that alone is enough for Better Auth to refuse the session.
	test("Better Auth rejects a cookie signed the old way", async () => {
		const signature = await base64UrlNoPadSignature(sessionToken, SECRET);
		expect(await readSession(`${sessionToken}.${signature}`)).toBeNull();
	});

	test("the two encodings differ only in alphabet and padding", async () => {
		const correct = await signSessionCookieValue(sessionToken, SECRET);
		const correctSignature = correct.slice(correct.lastIndexOf(".") + 1);
		const old = await base64UrlNoPadSignature(sessionToken, SECRET);

		// Same underlying MAC bytes — which is precisely why a crypto-utility
		// equivalence test cannot tell these apart, and why this suite reads the
		// cookie back through Better Auth instead.
		expect(
			correctSignature
				.replace(/\+/g, "-")
				.replace(/\//g, "_")
				.replace(/=+$/, ""),
		).toBe(old);
	});
});

describe("single signing site", () => {
	// `/next` and `/payload` each hand-rolled this; `/next` was correct and
	// `/payload` was not. Guard against a third implementation appearing.
	//
	// Comments are stripped before scanning — several files legitimately *talk*
	// about `base64urlnopad` and `makeSignature` while doing neither, and a
	// text-level grep that cannot tell prose from code is how the original
	// duplication went unnoticed.
	test("no entry point signs a session cookie on its own", async () => {
		const { Glob } = await import("bun");
		const ts = (await import("typescript")).default;
		const repo = new URL("../../", import.meta.url);

		const offenders: string[] = [];
		for await (const file of new Glob("src/**/*.ts").scan(repo.pathname)) {
			if (file.endsWith(".test.ts")) continue;
			if (file.replace(/\\/g, "/").endsWith("server/session-cookie.ts"))
				continue;

			const source = await Bun.file(new URL(file, repo)).text();
			const stripped = ts.transpileModule(source, {
				compilerOptions: {
					removeComments: true,
					target: ts.ScriptTarget.ESNext,
				},
			}).outputText;

			if (/createHmac|base64urlnopad|makeSignature/.test(stripped)) {
				offenders.push(file);
			}
		}
		expect(offenders).toEqual([]);
	});
});

describe("payload callback fails closed on signing failure", () => {
	test("no unsigned-cookie fallback remains in the payload handler", async () => {
		const source = await Bun.file(
			new URL("../payload/index.ts", import.meta.url),
		).text();
		// A fallback here returns 200 with a cookie Better Auth rejects: the
		// OAuth code is spent and a session row exists, but the user is not
		// signed in and the failure is invisible.
		expect(source).not.toContain("using unsigned value");
		expect(source).toContain(
			"const signedValue = await signSessionCookieValue(",
		);
		expect(source).not.toContain("let signedValue = sessionToken;");
	});
});
