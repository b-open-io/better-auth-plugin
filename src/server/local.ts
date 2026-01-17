/**
 * Local Signer Server Helpers
 *
 * Utilities for building a local sigma-auth server that LocalServerSigner can connect to.
 * Use these to create consistent API responses and validate access tokens.
 */

import { type AuthToken, parseAuthToken, verifyAuthToken } from "bitcoin-auth";

/**
 * Access token validation options
 */
export interface ValidateAccessTokenOptions {
	/** The access token from Authorization header */
	accessToken: string;
	/** Function to look up token state from database */
	findState: (accessToken: string) => Promise<{
		accessToken?: string;
		expireTime?: number;
		host?: string;
		scopes?: string[];
	} | null>;
	/** Required scopes (optional) */
	requiredScopes?: string[];
}

/**
 * Access token validation result
 */
export interface AccessTokenValidation {
	valid: boolean;
	error?: string;
	code?: number;
	host?: string;
	scopes?: string[];
}

/**
 * Validate an access token from Authorization header
 *
 * @example
 * ```typescript
 * import { validateAccessToken, extractAccessToken } from "@sigma-auth/better-auth-plugin/server/local";
 *
 * const authHeader = request.headers.get("authorization");
 * const accessToken = extractAccessToken(authHeader);
 *
 * const validation = await validateAccessToken({
 *   accessToken,
 *   findState: (token) => db.states.findOne({ accessToken: token }),
 * });
 *
 * if (!validation.valid) {
 *   return Response.json({ error: validation.error, success: false }, { status: 401 });
 * }
 * ```
 */
export async function validateAccessToken(
	options: ValidateAccessTokenOptions,
): Promise<AccessTokenValidation> {
	const { accessToken, findState, requiredScopes } = options;

	if (!accessToken) {
		return {
			valid: false,
			error: "Please provide an access token in the Authorization header.",
			code: 2,
		};
	}

	const state = await findState(accessToken);
	if (!state?.accessToken || state.accessToken !== accessToken) {
		return {
			valid: false,
			error: "Invalid access token.",
			code: 3,
		};
	}

	// Check expiration (0 means never expires)
	if (
		state.expireTime &&
		state.expireTime !== 0 &&
		state.expireTime < Date.now()
	) {
		return {
			valid: false,
			error: "Access token has expired.",
			code: 5,
		};
	}

	// Check required scopes
	if (requiredScopes?.length) {
		const hasAllScopes = requiredScopes.every((scope) =>
			state.scopes?.includes(scope),
		);
		if (!hasAllScopes) {
			return {
				valid: false,
				error: `Missing required scopes: ${requiredScopes.join(", ")}`,
				code: 6,
			};
		}
	}

	return {
		valid: true,
		host: state.host,
		scopes: state.scopes,
	};
}

/**
 * Extract access token from Authorization header
 * Supports both "Bearer <token>" and raw token formats
 */
export function extractAccessToken(authHeader: string | null): string | null {
	if (!authHeader) return null;
	return authHeader.replace(/^Bearer\s+/i, "").trim() || null;
}

/**
 * Standard error response format for local signer API
 */
export interface LocalSignerError {
	error: string;
	code?: number;
	success: false;
}

/**
 * Create a standard error response
 */
export function createErrorResponse(
	error: string,
	code?: number,
): LocalSignerError {
	return {
		error,
		code,
		success: false,
	};
}

/**
 * Response types for local signer endpoints
 */
export interface SignResponse {
	token: string;
	success: true;
}

export interface AIPSignResponse {
	signedOps: string[];
	success: true;
}

export interface EncryptResponse {
	ciphertext: string;
	success: true;
}

export interface DecryptResponse {
	data: string;
	success: true;
}

export interface FriendPubkeyResponse {
	publicKey: string;
	success: true;
}

export interface AuthResponse {
	accessToken: string;
	expireTime: number;
	host: string;
	success: true;
}

export interface StatusResponse {
	unlocked: boolean;
	success: true;
}

// Re-export bitcoin-auth functions for convenience
export { verifyAuthToken, parseAuthToken, type AuthToken };
