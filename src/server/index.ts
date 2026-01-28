import { getAuthToken } from "bitcoin-auth";
import type { SigmaUserInfo } from "../types/index.js";

// Re-export types for convenience
export type { BAPProfile, SigmaUserInfo } from "../types/index.js";

// Re-export admin plugin
export {
	type ExtendRolesCallback,
	type NFTCollection,
	type SigmaAdminOptions,
	sigmaAdminPlugin,
	type TokenGate,
} from "./admin.js";

export interface TokenExchangeOptions {
	code: string;
	redirectUri: string;
	clientId: string;
	memberPrivateKey: string;
	codeVerifier?: string;
	issuerUrl?: string;
}

export interface TokenExchangeResult {
	user: SigmaUserInfo;
	access_token: string;
	id_token: string;
	refresh_token?: string;
	/** Token expiry time in seconds from issuance */
	expires_in: number;
}

export interface TokenExchangeError {
	error: string;
	details?: string;
	status?: number;
	endpoint?: string;
}

/**
 * OAuth2 token response from the authorization server
 * @see https://www.rfc-editor.org/rfc/rfc6749#section-5.1
 */
export interface OAuth2TokenResponse {
	access_token: string;
	token_type: string;
	expires_in: number;
	refresh_token?: string;
	scope: string;
	/** OIDC id_token - only present when openid scope requested */
	id_token?: string;
}

/**
 * Exchange OAuth authorization code for access token
 * This function MUST be called server-side only as it requires the member private key
 *
 * @param options - Token exchange configuration
 * @returns Promise resolving to user data and tokens
 * @throws TokenExchangeError if exchange fails
 *
 * @example
 * ```typescript
 * import { exchangeCodeForTokens } from "@sigma-auth/better-auth-plugin/server";
 *
 * const result = await exchangeCodeForTokens({
 *   code: "authorization_code",
 *   redirectUri: "https://myapp.com/callback",
 *   clientId: "my-app",
 *   memberPrivateKey: process.env.SIGMA_MEMBER_PRIVATE_KEY,
 * });
 * ```
 */
export async function exchangeCodeForTokens(
	options: TokenExchangeOptions,
): Promise<TokenExchangeResult> {
	const {
		code,
		redirectUri,
		clientId,
		memberPrivateKey,
		codeVerifier,
		issuerUrl = "https://auth.sigmaidentity.com",
	} = options;

	// Build token request body
	const bodyParams: Record<string, string> = {
		grant_type: "authorization_code",
		code,
		redirect_uri: redirectUri,
		client_id: clientId,
	};

	if (codeVerifier) {
		bodyParams.code_verifier = codeVerifier;
	}

	const requestBody = new URLSearchParams(bodyParams).toString();

	// Create signed auth token using bitcoin-auth
	// CRITICAL: Must include body in signature to prevent request tampering
	// Path must match what the server expects: /api/auth/oauth2/token
	const authToken = getAuthToken({
		privateKeyWif: memberPrivateKey,
		requestPath: "/api/auth/oauth2/token",
		body: requestBody,
	});

	// Exchange code for tokens
	const tokenResponse = await fetch(`${issuerUrl}/api/auth/oauth2/token`, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			"X-Auth-Token": authToken,
		},
		body: requestBody,
	});

	if (!tokenResponse.ok) {
		// Parse error response to extract actual error message from auth server
		let errorCode = "token_exchange_failed";
		let errorDetails: string;

		const responseText = await tokenResponse.text();
		try {
			const errorJson = JSON.parse(responseText) as {
				error?: string;
				error_description?: string;
				message?: string;
			};
			// Use error_description if available, fall back to message or error
			errorDetails =
				errorJson.error_description ||
				errorJson.message ||
				errorJson.error ||
				responseText;
			errorCode = errorJson.error || errorCode;
		} catch {
			// Not JSON, use raw text
			errorDetails = responseText;
		}

		throw {
			error: errorCode,
			details: errorDetails,
			status: tokenResponse.status,
			endpoint: "/api/auth/oauth2/token",
		} as TokenExchangeError;
	}

	const tokens: OAuth2TokenResponse = await tokenResponse.json();

	// Validate that id_token is present (required for OIDC)
	if (!tokens.id_token) {
		throw {
			error: "Missing id_token in token response",
			details:
				"The authorization server did not return an id_token. Ensure 'openid' scope is included in the authorization request.",
			status: 500,
			endpoint: "/api/auth/oauth2/token",
		} as TokenExchangeError;
	}

	// Get user info with the access token
	const userInfoResponse = await fetch(
		`${issuerUrl}/api/auth/oauth2/userinfo`,
		{
			headers: {
				Authorization: `Bearer ${tokens.access_token}`,
			},
		},
	);

	if (!userInfoResponse.ok) {
		const userInfoError = await userInfoResponse.text();
		throw {
			error: "Failed to get user info",
			details: userInfoError,
			status: userInfoResponse.status,
			endpoint: "/api/auth/oauth2/userinfo",
		} as TokenExchangeError;
	}

	const userInfo = (await userInfoResponse.json()) as SigmaUserInfo;

	return {
		user: userInfo,
		access_token: tokens.access_token,
		id_token: tokens.id_token,
		refresh_token: tokens.refresh_token,
		expires_in: tokens.expires_in,
	};
}
