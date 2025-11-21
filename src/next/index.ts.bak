/**
 * Next.js App Router integration for Sigma Auth
 * Provides ready-to-use route handlers for OAuth callback
 */

import {
	exchangeCodeForTokens,
	type TokenExchangeError,
} from "../server/index.js";

interface NextRequest {
	json(): Promise<unknown>;
	nextUrl: {
		origin: string;
	};
}

/**
 * Configuration for the callback route handler
 * All values can be set via environment variables
 */
export interface CallbackRouteConfig {
	/** Sigma Auth server URL (default: NEXT_PUBLIC_SIGMA_AUTH_URL or https://auth.sigmaidentity.com) */
	issuerUrl?: string;
	/** OAuth client ID (default: NEXT_PUBLIC_SIGMA_CLIENT_ID) */
	clientId?: string;
	/** Member private key for signing (default: SIGMA_MEMBER_PRIVATE_KEY env) */
	memberPrivateKey?: string;
	/** Callback path (default: /callback) */
	callbackPath?: string;
}

/**
 * Creates a Next.js POST route handler for OAuth callback
 * This handler exchanges the authorization code for tokens using bitcoin-auth signature
 *
 * @example
 * ```typescript
 * // app/api/auth/callback/route.ts
 * import { createCallbackHandler } from "@sigma-auth/better-auth-plugin/next";
 *
 * export const runtime = "nodejs";
 * export const POST = createCallbackHandler();
 * ```
 *
 * @example
 * ```typescript
 * // With custom config
 * import { createCallbackHandler } from "@sigma-auth/better-auth-plugin/next";
 *
 * export const runtime = "nodejs";
 * export const POST = createCallbackHandler({
 *   callbackPath: "/auth/callback"
 * });
 * ```
 */
export function createCallbackHandler(config?: CallbackRouteConfig) {
	return async (request: NextRequest) => {
		try {
			const body = (await request.json()) as {
				code?: string;
				code_verifier?: string;
			};
			const { code, code_verifier } = body;

			if (!code) {
				return Response.json(
					{ error: "Missing authorization code" },
					{ status: 400 },
				);
			}

			// Get configuration from env or config
			const memberPrivateKey =
				config?.memberPrivateKey || process.env.SIGMA_MEMBER_PRIVATE_KEY;
			if (!memberPrivateKey) {
				console.error(
					"[Sigma OAuth Callback] SIGMA_MEMBER_PRIVATE_KEY not configured",
				);
				return Response.json(
					{
						error: "Server configuration error",
						details: "Missing SIGMA_MEMBER_PRIVATE_KEY",
					},
					{ status: 500 },
				);
			}

			const issuerUrl =
				config?.issuerUrl ||
				process.env.NEXT_PUBLIC_SIGMA_AUTH_URL ||
				"https://auth.sigmaidentity.com";

			const clientId =
				config?.clientId || process.env.NEXT_PUBLIC_SIGMA_CLIENT_ID;
			if (!clientId) {
				console.error(
					"[Sigma OAuth Callback] NEXT_PUBLIC_SIGMA_CLIENT_ID not configured",
				);
				return Response.json(
					{ error: "Server configuration error", details: "Missing client ID" },
					{ status: 500 },
				);
			}

			const callbackPath = config?.callbackPath || "/callback";
			const redirectUri = `${request.nextUrl.origin}${callbackPath}`;

			console.log("[Sigma OAuth Callback] Exchanging code for tokens:", {
				issuerUrl,
				clientId,
				redirectUri,
			});

			const result = await exchangeCodeForTokens({
				code,
				redirectUri,
				clientId,
				memberPrivateKey,
				codeVerifier: code_verifier,
				issuerUrl,
			});

			console.log("[Sigma OAuth Callback] Success:", {
				hasBap: !!result.user.bap,
				name: result.user.name,
				bapId: result.user.bap?.idKey?.substring(0, 20) || "none",
			});

			return Response.json({
				user: result.user,
				access_token: result.access_token,
				refresh_token: result.refresh_token,
			});
		} catch (error) {
			console.error("[Sigma OAuth Callback] Error:", error);

			// Check if it's a TokenExchangeError
			if (
				error &&
				typeof error === "object" &&
				"error" in error &&
				"endpoint" in error
			) {
				const tokenError = error as TokenExchangeError;
				return Response.json(
					{
						error: tokenError.error,
						details: tokenError.details,
						status: tokenError.status,
						endpoint: tokenError.endpoint,
					},
					{ status: tokenError.status || 500 },
				);
			}

			return Response.json(
				{
					error: "Internal server error",
					details: error instanceof Error ? error.message : "Unknown error",
				},
				{ status: 500 },
			);
		}
	};
}

/**
 * Runtime configuration for Next.js route
 * Set to nodejs to support bitcoin-auth cryptography
 */
export const runtime = "nodejs";
