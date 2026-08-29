/**
 * Small Web Crypto helper used by the `/provider` entry point.
 *
 * This deliberately reimplements the `@better-auth/utils` helpers this package
 * used to reach for. `@better-auth/utils` is a *transitive* dependency
 * of `better-auth`, not a declared dependency of this package, so importing it
 * only worked where the installer happened to flatten it to the top level.
 * Under pnpm's strict layout, Yarn PnP, or any nested install it is not
 * resolvable and the shipped entry point fails with `ERR_MODULE_NOT_FOUND`.
 *
 * Better Auth exposes no public re-export of `createHash`/`base64Url`
 * (`better-auth/crypto` carries password, JWT, envelope and *cookie-signature*
 * helpers, but not these), so the choice was between declaring a direct
 * dependency on an internal package whose version is coupled to `better-auth`'s
 * own resolution, or reimplementing ~20 lines of standard Web Crypto. The
 * latter keeps the runtime dependency surface at zero.
 *
 * Note the deliberate absence of an HMAC helper here. Session-cookie signing
 * lives in `../server/session-cookie.ts` and delegates to Better Auth's public
 * `makeSignature`, because that value must be padded *standard* Base64 — not
 * the base64url this module produces. Reusing a base64url helper for a cookie
 * signature is exactly the bug that shipped in `/payload`.
 *
 * The output is byte-identical to `@better-auth/utils`, which
 * `src/utils/webcrypto.test.ts` proves against the real implementation over
 * random inputs.
 *
 * Only `globalThis.crypto.subtle`, `TextEncoder` and `btoa` are used, all of
 * which are available on Node >= 18, Bun, Deno, Cloudflare Workers and the
 * Vercel Edge runtime.
 */

const BASE64URL_ALPHABET =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * RFC 4648 §5 base64url, **without** padding — the `base64urlnopad` encoding
 * Better Auth uses for hashed tokens and signed session cookies.
 */
export function base64UrlEncodeNoPad(bytes: Uint8Array): string {
	let result = "";
	let buffer = 0;
	let shift = 0;
	for (const byte of bytes) {
		buffer = (buffer << 8) | byte;
		shift += 8;
		while (shift >= 6) {
			shift -= 6;
			result += BASE64URL_ALPHABET[(buffer >> shift) & 63];
		}
	}
	if (shift > 0) {
		result += BASE64URL_ALPHABET[(buffer << (6 - shift)) & 63];
	}
	return result;
}

/**
 * SHA-256 of a UTF-8 string, base64url-encoded without padding.
 *
 * Equivalent to `createHash("SHA-256").digest(...)` piped through
 * `base64Url.encode(..., { padding: false })`, which is how Better Auth's
 * OAuth provider derives the lookup key for `storeTokens: "hashed"`.
 */
export async function sha256Base64UrlNoPad(value: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return base64UrlEncodeNoPad(new Uint8Array(digest));
}
