/**
 * Payload CMS integration for Sigma Auth
 * Provides callback handler that creates local better-auth sessions for Payload
 *
 * @example
 * ```typescript
 * // app/api/auth/sigma/callback/route.ts
 * import configPromise from "@payload-config";
 * import { createPayloadCallbackHandler } from "@sigma-auth/better-auth-plugin/payload";
 *
 * export const POST = createPayloadCallbackHandler({ configPromise });
 * ```
 */

import type { AuthContext } from "@better-auth/core";
import {
	exchangeCodeForTokens,
	type TokenExchangeError,
	type TokenExchangeResult,
} from "../server/index.js";

/**
 * Next.js request interface (minimal typing for compatibility)
 */
interface NextRequest {
	json(): Promise<unknown>;
	url: string;
	headers: Headers;
}

/**
 * Payload instance with better-auth (from payload-auth)
 */
interface PayloadWithBetterAuth {
	find: (args: {
		collection: string;
		where: Record<string, unknown>;
		limit: number;
	}) => Promise<{ docs: Array<{ id: number | string }> }>;
	create: (args: {
		collection: string;
		data: Record<string, unknown>;
	}) => Promise<{ id: number | string }>;
	betterAuth: {
		$context: Promise<AuthContext>;
	};
}

/**
 * Configuration for the Payload callback handler
 */
export interface PayloadCallbackConfig {
	/**
	 * Payload config promise (import configPromise from "@payload-config")
	 * Will be used to get the Payload instance via getPayloadAuth
	 */
	configPromise: Promise<unknown>;

	/**
	 * Function to get the Payload instance with better-auth
	 * If not provided, will dynamically import from payload-auth/better-auth
	 */
	getPayloadAuth?: (config: Promise<unknown>) => Promise<PayloadWithBetterAuth>;

	/** Sigma Auth server URL (default: NEXT_PUBLIC_SIGMA_AUTH_URL or https://auth.sigmaidentity.com) */
	issuerUrl?: string;

	/** OAuth client ID (default: NEXT_PUBLIC_SIGMA_CLIENT_ID) */
	clientId?: string;

	/** Member private key for signing (default: SIGMA_MEMBER_PRIVATE_KEY env) */
	memberPrivateKey?: string;

	/** Callback path (default: /auth/sigma/callback) */
	callbackPath?: string;

	/** Users collection slug (default: "users") */
	usersCollection?: string;

	/** Sessions collection slug (default: "sessions") */
	sessionsCollection?: string;

	/** Session cookie name (default: "better-auth.session_token") */
	sessionCookieName?: string;

	/** Session duration in milliseconds (default: 30 days) */
	sessionDuration?: number;

	/**
	 * Custom user creation handler
	 * Override to customize how users are created from Sigma identity
	 */
	createUser?: (
		payload: PayloadWithBetterAuth,
		sigmaUser: TokenExchangeResult["user"],
	) => Promise<{ id: number | string }>;

	/**
	 * Custom user lookup handler
	 * Override to customize how existing users are found
	 */
	findUser?: (
		payload: PayloadWithBetterAuth,
		sigmaUser: TokenExchangeResult["user"],
	) => Promise<{ id: number | string } | null>;
}

/**
 * Result returned from the callback handler
 */
export interface PayloadCallbackResult extends TokenExchangeResult {
	/** The Payload user ID that was created or found */
	payloadUserId: string;
	/** Whether a new user was created */
	isNewUser: boolean;
}

/**
 * Creates a Next.js POST route handler for Sigma OAuth callback with Payload session creation
 *
 * This handler:
 * 1. Exchanges the authorization code for tokens
 * 2. Finds or creates a user in Payload
 * 3. Creates a better-auth session in Payload's sessions collection
 * 4. Sets the session cookie
 * 5. Returns the tokens and user data
 *
 * @example
 * ```typescript
 * // app/api/auth/sigma/callback/route.ts
 * import configPromise from "@payload-config";
 * import { createPayloadCallbackHandler } from "@sigma-auth/better-auth-plugin/payload";
 *
 * export const POST = createPayloadCallbackHandler({ configPromise });
 * ```
 *
 * @example
 * ```typescript
 * // With custom user creation
 * export const POST = createPayloadCallbackHandler({
 *   configPromise,
 *   createUser: async (payload, sigmaUser) => {
 *     return payload.create({
 *       collection: "users",
 *       data: {
 *         email: sigmaUser.email,
 *         name: sigmaUser.name,
 *         emailVerified: true,
 *         role: ["subscriber"], // Custom role
 *         bapId: sigmaUser.bap_id,
 *       },
 *     });
 *   },
 * });
 * ```
 */
export function createPayloadCallbackHandler(config: PayloadCallbackConfig) {
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
				config.memberPrivateKey || process.env.SIGMA_MEMBER_PRIVATE_KEY;
			if (!memberPrivateKey) {
				console.error(
					"[Sigma Payload Callback] SIGMA_MEMBER_PRIVATE_KEY not configured",
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
				config.issuerUrl ||
				process.env.NEXT_PUBLIC_SIGMA_AUTH_URL ||
				"https://auth.sigmaidentity.com";

			const clientId =
				config.clientId || process.env.NEXT_PUBLIC_SIGMA_CLIENT_ID;
			if (!clientId) {
				console.error(
					"[Sigma Payload Callback] NEXT_PUBLIC_SIGMA_CLIENT_ID not configured",
				);
				return Response.json(
					{ error: "Server configuration error", details: "Missing client ID" },
					{ status: 500 },
				);
			}

			const callbackPath = config.callbackPath || "/auth/sigma/callback";

			// Determine origin from headers or env
			let origin = process.env.NEXT_PUBLIC_SERVER_URL;
			if (!origin) {
				const forwardedHost = request.headers.get("x-forwarded-host");
				const forwardedProto =
					request.headers.get("x-forwarded-proto") || "https";
				if (forwardedHost) {
					origin = `${forwardedProto}://${forwardedHost}`;
				} else {
					origin = new URL(request.url).origin;
				}
			}
			const redirectUri = `${origin}${callbackPath}`;

			console.log("[Sigma Payload Callback] Exchanging code for tokens:", {
				issuerUrl,
				clientId,
				redirectUri,
			});

			// Exchange authorization code for tokens
			const result = await exchangeCodeForTokens({
				code,
				redirectUri,
				clientId,
				memberPrivateKey,
				codeVerifier: code_verifier,
				issuerUrl,
			});

			console.log("[Sigma Payload Callback] Token exchange success:", {
				hasBap: !!result.user.bap,
				name: result.user.name,
				bapId: result.user.bap_id?.substring(0, 20) || "none",
			});

			// Get Payload instance
			let payload: PayloadWithBetterAuth;
			if (config.getPayloadAuth) {
				payload = await config.getPayloadAuth(config.configPromise);
			} else {
				// Dynamic import to avoid hard dependency
				// @ts-expect-error - payload-auth is an optional peer dependency
				const mod = await import("payload-auth/better-auth");
				payload = await mod.getPayloadAuth(config.configPromise);
			}

			const usersCollection = config.usersCollection || "users";
			// Note: sessionsCollection config is no longer used - sessions are created via Better Auth's internal adapter

			// Find or create user
			let userId: string;
			let isNewUser = false;

			if (config.findUser) {
				const existingUser = await config.findUser(payload, result.user);
				if (existingUser) {
					userId = String(existingUser.id);
				} else if (config.createUser) {
					const newUser = await config.createUser(payload, result.user);
					userId = String(newUser.id);
					isNewUser = true;
				} else {
					// Default user creation
					const email =
						result.user.email || `${result.user.sub}@sigma.identity`;
					const newUser = await payload.create({
						collection: usersCollection,
						data: {
							email,
							name: result.user.name || result.user.sub,
							emailVerified: true,
							role: ["user"],
						},
					});
					userId = String(newUser.id);
					isNewUser = true;
				}
			} else {
				// Default user lookup by email
				const email = result.user.email || `${result.user.sub}@sigma.identity`;
				const users = await payload.find({
					collection: usersCollection,
					where: { email: { equals: email } },
					limit: 1,
				});

				const existingUser = users.docs[0];
				if (existingUser) {
					userId = String(existingUser.id);
				} else if (config.createUser) {
					const newUser = await config.createUser(payload, result.user);
					userId = String(newUser.id);
					isNewUser = true;
				} else {
					// Default user creation
					const newUser = await payload.create({
						collection: usersCollection,
						data: {
							email,
							name: result.user.name || result.user.sub,
							emailVerified: true,
							role: ["user"],
						},
					});
					userId = String(newUser.id);
					isNewUser = true;
				}
			}

			console.log(
				"[Sigma Payload Callback]",
				isNewUser ? "Created new user:" : "Found existing user:",
				userId,
			);

			// Create session using Better Auth's internal adapter
			// This properly handles all field validations and schema requirements
			const ctx = await payload.betterAuth.$context;
			const session = await ctx.internalAdapter.createSession(userId);

			const sessionToken = session.token;

			// Set session cookie using dynamic import to avoid hard dependency on next/headers
			const sessionCookieName =
				config.sessionCookieName || "better-auth.session_token";
			try {
				// @ts-expect-error - next/headers is only available in Next.js route handlers
				const mod = await import("next/headers");
				const cookieStore = await mod.cookies();
				cookieStore.set(sessionCookieName, sessionToken, {
					httpOnly: true,
					secure: process.env.NODE_ENV === "production",
					sameSite: "lax",
					path: "/",
					expires: session.expiresAt,
				});
			} catch {
				// Fallback: set cookie via response header if next/headers not available
				// This shouldn't happen in Next.js route handlers but provides fallback
				console.warn(
					"[Sigma Payload Callback] Could not set cookie via next/headers",
				);
			}

			console.log("[Sigma Payload Callback] Session created for user:", userId);

			return Response.json({
				user: result.user,
				access_token: result.access_token,
				id_token: result.id_token,
				refresh_token: result.refresh_token,
				expires_in: result.expires_in,
				payloadUserId: userId,
				isNewUser,
			} satisfies PayloadCallbackResult);
		} catch (error) {
			console.error("[Sigma Payload Callback] Error:", error);

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
