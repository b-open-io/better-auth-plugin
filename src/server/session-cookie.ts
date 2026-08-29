/**
 * Shared construction of Better Auth's signed session-cookie value.
 *
 * Better Auth writes its session cookie through better-call's
 * `setSignedCookie`, and reads it back through `getSignedCookie`, which applies
 * this gate before it will even attempt verification
 * (`better-call/dist/context.mjs`):
 *
 * ```js
 * if (signature.length !== 44 || !signature.endsWith("=")) return null;
 * ```
 *
 * That is **padded, standard Base64** — a 32-byte HMAC-SHA-256 encodes to 44
 * characters ending in `=`. A base64url signature (43 characters, `-`/`_`
 * alphabet, no padding) is silently rejected: the callback reports success and
 * the very next session read fails.
 *
 * Both `/next` and `/payload` hand-rolled this. `/next` got it right and even
 * carried a comment about the 44-character rule; `/payload` did not, and signed
 * with `base64urlnopad` for as long as it has existed. Two implementations, one
 * of them wrong, is the reason this module exists: there is now a single
 * signing site, and it delegates to Better Auth's own public `makeSignature`
 * rather than reproducing the encoding a third time.
 */

import { makeSignature } from "better-auth/crypto";

/**
 * Length of a valid session-cookie signature, and the suffix better-call
 * requires. Exported so tests can assert against the gate directly rather than
 * restating the magic number.
 */
export const SESSION_COOKIE_SIGNATURE_LENGTH = 44;
export const SESSION_COOKIE_SIGNATURE_SUFFIX = "=";

/**
 * Produces the `<token>.<signature>` cookie value Better Auth verifies.
 *
 * The caller is responsible for `encodeURIComponent`-ing the result before
 * putting it in a `Set-Cookie` header, exactly as better-call's
 * `signCookieValue` does.
 */
export async function signSessionCookieValue(
	token: string,
	secret: string,
): Promise<string> {
	const signature = await makeSignature(token, secret);
	return `${token}.${signature}`;
}
