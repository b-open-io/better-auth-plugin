/**
 * Next.js App Router integration for Sigma Auth
 * Provides ready-to-use route handlers for OAuth callback
 */

import crypto from "node:crypto";
import type { Auth } from "better-auth";

import {
	exchangeCodeForTokens,
	type TokenExchangeError,
	type TokenExchangeResult,
} from "../server/index.js";

interface NextRequest {
	json(): Promise<unknown>;
	nextUrl: {
		origin: string;
	};
	headers: Headers;
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
	/** Callback path (default: /auth/sigma/callback) */
	callbackPath?: string;
}

/**
 * Creates a Next.js POST route handler for OAuth callback
 * This handler exchanges the authorization code for tokens using bitcoin-auth signature
 *
 * @example
 * ```typescript
 * // app/api/auth/sigma/callback/route.ts
 * import { createCallbackHandler } from "@sigma-auth/better-auth-plugin/next";
 *
 * export const POST = createCallbackHandler();
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

			const callbackPath = config?.callbackPath || "/auth/sigma/callback";

			// Determine the origin - prefer explicit env var, then x-forwarded headers, then request origin
			// This handles reverse proxy scenarios where request.nextUrl.origin returns localhost
			let origin = process.env.NEXT_PUBLIC_APP_URL;
			if (!origin) {
				const forwardedHost = request.headers.get("x-forwarded-host");
				const forwardedProto =
					request.headers.get("x-forwarded-proto") || "https";
				if (forwardedHost) {
					origin = `${forwardedProto}://${forwardedHost}`;
				} else {
					origin = request.nextUrl.origin;
				}
			}
			const redirectUri = `${origin}${callbackPath}`;

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
				bapId: result.user.bap_id?.substring(0, 20) || "none",
			});

			return Response.json({
				user: result.user,
				access_token: result.access_token,
				id_token: result.id_token,
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
 * Error info extracted from URL search params
 */
export interface SigmaAuthError {
	error: string;
	errorDescription: string;
}

/**
 * Parse error from URL search params on error callback page
 *
 * @param searchParams - URL search params from error callback
 * @returns Parsed error info or null if no error
 *
 * @example
 * ```typescript
 * // app/auth/sigma/error/page.tsx
 * import { parseErrorParams } from "@sigma-auth/better-auth-plugin/next";
 *
 * export default function ErrorPage() {
 *   const searchParams = useSearchParams();
 *   const error = parseErrorParams(searchParams);
 *
 *   return (
 *     <div>
 *       <h1>{error?.error || "Unknown Error"}</h1>
 *       <p>{error?.errorDescription}</p>
 *     </div>
 *   );
 * }
 * ```
 */
export function parseErrorParams(
	searchParams: URLSearchParams | { get: (key: string) => string | null },
): SigmaAuthError | null {
	const error = searchParams.get("error");
	if (!error) return null;

	return {
		error,
		errorDescription:
			searchParams.get("error_description") || "An unknown error occurred",
	};
}

/**
 * Extract adapter type from Auth for use in custom handlers
 */
type AuthAdapter = Awaited<Auth["$context"]>["adapter"];

/**
 * Extract user data from token exchange for custom handlers
 */
type SigmaUser = TokenExchangeResult["user"];

/**
 * Configuration for the Better Auth callback route handler
 */
export interface BetterAuthCallbackConfig extends CallbackRouteConfig {
	/**
	 * Better Auth instance from your auth-server.ts
	 * @example
	 * ```typescript
	 * import { auth } from "@/lib/auth-server";
	 * export const POST = createBetterAuthCallbackHandler({ auth });
	 * ```
	 */
	auth: Auth;

	/**
	 * Custom user creation handler
	 * Override to customize how users are created from Sigma identity
	 */
	createUser?: (
		adapter: AuthAdapter,
		sigmaUser: SigmaUser,
	) => Promise<{ id: string }>;

	/**
	 * Custom user lookup handler
	 * Override to customize how existing users are found
	 */
	findUser?: (
		adapter: AuthAdapter,
		sigmaUser: SigmaUser,
	) => Promise<{ id: string } | null>;

	/**
	 * Custom user update handler
	 * Override to customize how existing users are updated with latest profile data
	 * Set to false to disable updates entirely
	 */
	updateUser?:
		| ((
				adapter: AuthAdapter,
				userId: string,
				sigmaUser: SigmaUser,
		  ) => Promise<void>)
		| false;
}

/**
 * Result returned from the Better Auth callback handler
 */
export interface BetterAuthCallbackResult extends TokenExchangeResult {
	/** The Better Auth user ID */
	userId: string;
	/** Whether a new user was created */
	isNewUser: boolean;
}

/**
 * Creates a Next.js POST route handler for Sigma OAuth callback with Better Auth session creation
 *
 * This handler:
 * 1. Exchanges the authorization code for tokens
 * 2. Finds or creates a user in Better Auth
 * 3. Creates a session via Better Auth's internal adapter
 * 4. Sets the session cookie
 * 5. Returns the tokens and user data
 *
 * @example
 * ```typescript
 * // app/api/auth/sigma/callback/route.ts
 * import { createBetterAuthCallbackHandler } from "@sigma-auth/better-auth-plugin/next";
 * import { auth } from "@/lib/auth-server";
 *
 * export const runtime = "nodejs";
 * export const POST = createBetterAuthCallbackHandler({ auth });
 * ```
 *
 * @example
 * ```typescript
 * // With custom user creation
 * export const POST = createBetterAuthCallbackHandler({
 *   auth,
 *   createUser: async (adapter, sigmaUser) => {
 *     return adapter.create({
 *       model: "user",
 *       data: {
 *         email: sigmaUser.email,
 *         name: sigmaUser.name,
 *         emailVerified: true,
 *         bapId: sigmaUser.bap_id,
 *         role: "subscriber", // Custom field
 *         createdAt: new Date(),
 *         updatedAt: new Date(),
 *       },
 *     });
 *   },
 * });
 * ```
 */
export function createBetterAuthCallbackHandler(
	config: BetterAuthCallbackConfig,
) {
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
					"[Sigma BA Callback] SIGMA_MEMBER_PRIVATE_KEY not configured",
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
					"[Sigma BA Callback] NEXT_PUBLIC_SIGMA_CLIENT_ID not configured",
				);
				return Response.json(
					{ error: "Server configuration error", details: "Missing client ID" },
					{ status: 500 },
				);
			}

			const callbackPath = config.callbackPath || "/auth/sigma/callback";

			// Determine the origin
			let origin = process.env.NEXT_PUBLIC_APP_URL;
			if (!origin) {
				const forwardedHost = request.headers.get("x-forwarded-host");
				const forwardedProto =
					request.headers.get("x-forwarded-proto") || "https";
				if (forwardedHost) {
					origin = `${forwardedProto}://${forwardedHost}`;
				} else {
					origin = request.nextUrl.origin;
				}
			}
			const redirectUri = `${origin}${callbackPath}`;

			console.log(
				`[Sigma BA Callback] Exchanging code for tokens: clientId=${clientId}, redirectUri=${redirectUri}`,
			);

			// Exchange authorization code for tokens
			const result = await exchangeCodeForTokens({
				code,
				redirectUri,
				clientId,
				memberPrivateKey,
				codeVerifier: code_verifier,
				issuerUrl,
			});

			const bapId =
				result.user.bap_id ||
				(typeof result.user.bap === "object"
					? result.user.bap?.idKey
					: undefined);
			console.log(
				`[Sigma BA Callback] Token exchange success: name=${result.user.name}, bapId=${bapId?.substring(0, 20) || "none"}`,
			);

			// Get Better Auth context
			const ctx = await config.auth.$context;
			const { adapter, internalAdapter } = ctx;

			// Extract user info from Sigma response
			const bap = typeof result.user.bap === "object" ? result.user.bap : null;
			const email = result.user.email || `${result.user.sub}@sigma.local`;
			const name = result.user.name || bap?.identity?.alternateName || "User";
			const image = result.user.picture || bap?.identity?.image;

			// Find or create user
			let userId: string;
			let isNewUser = false;

			if (config.findUser) {
				const existingUser = await config.findUser(adapter, result.user);
				if (existingUser) {
					userId = existingUser.id;
					// Update user if handler provided
					if (config.updateUser !== false) {
						if (config.updateUser) {
							await config.updateUser(adapter, userId, result.user);
						} else {
							// Default update
							await adapter.update({
								model: "user",
								where: [{ field: "id", value: userId }],
								update: {
									name,
									image,
									bapId,
									updatedAt: new Date(),
								},
							});
						}
					}
				} else if (config.createUser) {
					const newUser = await config.createUser(adapter, result.user);
					userId = newUser.id;
					isNewUser = true;
				} else {
					// Default user creation
					const newUser = await adapter.create<{ id: string }>({
						model: "user",
						data: {
							email,
							name,
							image,
							bapId,
							emailVerified: true,
							createdAt: new Date(),
							updatedAt: new Date(),
						},
					});
					userId = newUser.id;
					isNewUser = true;
				}
			} else {
				// Default user lookup by email
				const existingUser = await adapter.findOne<{ id: string }>({
					model: "user",
					where: [{ field: "email", value: email }],
				});

				if (existingUser) {
					userId = existingUser.id;
					// Update user with latest profile data
					if (config.updateUser !== false) {
						if (config.updateUser) {
							await config.updateUser(adapter, userId, result.user);
						} else {
							await adapter.update({
								model: "user",
								where: [{ field: "id", value: userId }],
								update: {
									name,
									image,
									bapId,
									updatedAt: new Date(),
								},
							});
						}
					}
				} else if (config.createUser) {
					const newUser = await config.createUser(adapter, result.user);
					userId = newUser.id;
					isNewUser = true;
				} else {
					// Default user creation
					const newUser = await adapter.create<{ id: string }>({
						model: "user",
						data: {
							email,
							name,
							image,
							bapId,
							emailVerified: true,
							createdAt: new Date(),
							updatedAt: new Date(),
						},
					});
					userId = newUser.id;
					isNewUser = true;
				}
			}

			console.log(
				"[Sigma BA Callback]",
				isNewUser ? "Created new user:" : "Found existing user:",
				userId,
			);

			// Create or update account record for multi-provider support
			const sigmaAccountId = result.user.sub;
			const existingAccount = await adapter.findOne<{ id: string }>({
				model: "account",
				where: [
					{ field: "providerId", value: "sigma" },
					{ field: "accountId", value: sigmaAccountId },
				],
			});

			const now = new Date();
			const accessTokenExpiresAt = result.expires_in
				? new Date(Date.now() + result.expires_in * 1000)
				: null;

			if (existingAccount) {
				// Update existing account with fresh tokens
				await adapter.update({
					model: "account",
					where: [{ field: "id", value: existingAccount.id }],
					update: {
						accessToken: result.access_token,
						refreshToken: result.refresh_token,
						idToken: result.id_token,
						accessTokenExpiresAt,
						updatedAt: now,
					},
				});
				console.log(
					"[Sigma BA Callback] Updated account record:",
					existingAccount.id,
				);
			} else {
				// Create new account record
				const accountId =
					typeof ctx.generateId === "function"
						? ctx.generateId({ model: "account", size: 32 })
						: crypto.randomUUID();
				await adapter.create({
					model: "account",
					data: {
						id: accountId,
						accountId: sigmaAccountId,
						providerId: "sigma",
						userId,
						accessToken: result.access_token,
						refreshToken: result.refresh_token,
						idToken: result.id_token,
						accessTokenExpiresAt,
						createdAt: now,
						updatedAt: now,
					},
				});
				console.log("[Sigma BA Callback] Created account record:", accountId);
			}

			// Create session using internal adapter
			const session = await internalAdapter.createSession(
				userId,
				false, // dontRememberMe
			);

			if (!session) {
				console.error("[Sigma BA Callback] Failed to create session");
				return Response.json(
					{ error: "Failed to create session" },
					{ status: 500 },
				);
			}

			console.log(
				"[Sigma BA Callback] Session created:",
				`${session.token.substring(0, 20)}...`,
			);

			// Build session cookie
			const sessionCookieName = ctx.authCookies.sessionToken.name;
			const sessionTokenConfig = ctx.authCookies.sessionToken as {
				name: string;
				attributes?: Record<string, unknown>;
				options?: Record<string, unknown>;
			};
			const cookieAttrs =
				sessionTokenConfig.attributes || sessionTokenConfig.options || {};

			// Sign the session token with HMAC-SHA256
			// MUST use standard base64 (not base64url) to match better-call's
			// getSignedCookie() which expects exactly 44 chars ending with "="
			const signature = crypto
				.createHmac("sha256", ctx.secret)
				.update(session.token)
				.digest("base64");
			const signedToken = `${session.token}.${signature}`;

			const cookiePath = (cookieAttrs?.path as string) ?? "/";
			const cookieSecure = (cookieAttrs?.secure as boolean) ?? true;
			const cookieSameSite = ((cookieAttrs?.sameSite as string) ?? "lax") as
				| "lax"
				| "strict"
				| "none";
			const maxAge = ctx.sessionConfig.expiresIn;

			console.log("[Sigma BA Callback] Setting cookie:", sessionCookieName);

			const responseBody = {
				user: {
					...result.user,
					sub: userId,
				},
				access_token: result.access_token,
				id_token: result.id_token,
				refresh_token: result.refresh_token,
				expires_in: result.expires_in,
				userId,
				isNewUser,
			} satisfies BetterAuthCallbackResult;

			// Set cookie via Set-Cookie response header
			// Note: Do NOT use Next.js cookies().set() + Response.json() - Next.js
			// only merges mutable cookies into NextResponse, not plain Response.
			// A plain Response with Set-Cookie header works correctly.
			const encodedToken = encodeURIComponent(signedToken);
			const cookieValue = `${sessionCookieName}=${encodedToken}; Path=${cookiePath}; HttpOnly; ${cookieSecure ? "Secure; " : ""}SameSite=${cookieSameSite}; Max-Age=${maxAge}`;
			return new Response(JSON.stringify(responseBody), {
				status: 200,
				headers: {
					"Content-Type": "application/json",
					"Set-Cookie": cookieValue,
				},
			});
		} catch (error) {
			console.error("[Sigma BA Callback] Error:", error);

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
