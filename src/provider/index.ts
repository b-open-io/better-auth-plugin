import { base64Url } from "@better-auth/utils/base64";
import { createHash } from "@better-auth/utils/hash";
import { PublicKey } from "@bsv/sdk";
import type { Pool } from "@neondatabase/serverless";
import type { BetterAuthPlugin, User } from "better-auth";
import {
	APIError,
	createAuthEndpoint,
	createAuthMiddleware,
	sessionMiddleware,
} from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
// Import organization from dedicated path for tree-shaking (per Better Auth best practices)
import {
	type OrganizationOptions,
	organization,
} from "better-auth/plugins/organization";
import { parseAuthToken, verifyAuthToken } from "bitcoin-auth";
import { z } from "zod";

/**
 * Hash a token using SHA-256, matching oauth-provider's storeTokens: "hashed" behavior
 */
const hashToken = async (token: string): Promise<string> => {
	const hash = await createHash("SHA-256").digest(
		new TextEncoder().encode(token),
	);
	return base64Url.encode(new Uint8Array(hash), { padding: false });
};

/**
 * Debug logger that only logs when debug mode is enabled
 */
interface DebugLogger {
	log: (message: string, ...args: unknown[]) => void;
	warn: (message: string, ...args: unknown[]) => void;
	error: (message: string, ...args: unknown[]) => void;
}

function createDebugLogger(enabled: boolean): DebugLogger {
	const noop = () => {};
	if (!enabled) {
		return { log: noop, warn: noop, error: noop };
	}
	return {
		log: (message: string, ...args: unknown[]) => {
			console.log(`[Sigma Debug] ${message}`, ...args);
		},
		warn: (message: string, ...args: unknown[]) => {
			console.warn(`[Sigma Debug] ${message}`, ...args);
		},
		error: (message: string, ...args: unknown[]) => {
			console.error(`[Sigma Debug] ${message}`, ...args);
		},
	};
}

/**
 * Base OAuth client from Better Auth oauth-provider plugin
 */
interface BaseOAuthClient {
	clientId: string;
	redirectUris: string[];
	name: string;
	uri?: string;
	icon?: string;
	logoUri?: string;
	tosUri?: string;
	policyUri?: string;
	contacts?: string;
	public: boolean;
	disabled?: boolean;
}

/**
 * OAuth client with Sigma-specific extensions
 */
interface OAuthClient extends BaseOAuthClient {
	memberPubkey?: string; // Account public key for signature verification (DB column name)
	ownerBapId: string; // BAP ID of the client owner
}

/**
 * Configuration options for the Sigma Auth provider plugin
 */
export interface SigmaProviderOptions {
	/**
	 * Optional BAP (Bitcoin Attestation Protocol) ID resolver
	 * Resolves a Bitcoin pubkey to a BAP ID and registers it
	 * @param pool Database connection pool (implementation-specific)
	 * @param userId User ID in your database
	 * @param pubkey Bitcoin public key
	 * @param register Whether to register the BAP ID
	 * @returns BAP ID or null if not found
	 */
	resolveBAPId?: (
		pool: Pool,
		userId: string,
		pubkey: string,
		register: boolean,
	) => Promise<string | null>;

	/**
	 * Optional database pool getter
	 * Returns a database connection pool for BAP ID resolution
	 */
	getPool?: () => Pool;

	/**
	 * Optional cache implementation for BAP ID caching and OAuth consent state
	 * Should provide get/set/delete methods for key-value storage
	 * The set method should accept an optional options object for TTL configuration
	 */
	cache?: {
		get: <T = unknown>(key: string) => Promise<T | null>;
		set: (
			key: string,
			value: unknown,
			options?: { ex?: number },
		) => Promise<void>;
		delete?: (key: string) => Promise<void>;
	};

	/**
	 * Enable subscription tier support
	 * Adds subscriptionTier field to user and session
	 * @default false
	 */
	enableSubscription?: boolean;

	/**
	 * Enable debug logging for troubleshooting
	 * Logs headers and request details to help diagnose auth issues
	 * @default false
	 */
	debug?: boolean;
}

/**
 * Options for customizing the BAP identity organization config
 */
export interface BapOrganizationOptions {
	/**
	 * Additional options to merge with the base organization config
	 */
	additionalOptions?: Partial<OrganizationOptions>;
}

/**
 * Create the organization plugin configured for BAP identities
 *
 * BAP identities are personal - each organization has exactly one owner (the user).
 * This config disables invitations and multi-member organizations.
 *
 * @example
 * ```typescript
 * import { betterAuth } from "better-auth";
 * import { sigmaProvider, createBapOrganization } from "@sigma-auth/better-auth-plugin/provider";
 *
 * export const auth = betterAuth({
 *   plugins: [
 *     sigmaProvider({ ... }),
 *     createBapOrganization(),
 *   ],
 * });
 * ```
 */
export const createBapOrganization = (options?: BapOrganizationOptions) => {
	return organization({
		// BAP IDs are personal identities - disable invitations
		sendInvitationEmail: async () => {
			throw new Error("Invitations not supported for BAP identities");
		},
		// Users can create organizations (BAP identities)
		allowUserToCreateOrganization: true,
		// Creator is always the owner
		creatorRole: "owner",
		// Single member per organization
		membershipLimit: 1,
		// Merge any additional options
		...options?.additionalOptions,
	});
};

// Re-export for convenience
export { organization };
export type { OrganizationOptions };

/**
 * Sigma Auth provider plugin for Better Auth
 * This is the OAuth provider that runs on auth.sigmaidentity.com
 *
 * @example
 * ```typescript
 * import { betterAuth } from "better-auth";
 * import { sigmaProvider } from "@sigma-auth/better-auth-plugin/provider";
 *
 * export const auth = betterAuth({
 *   plugins: [
 *     sigmaProvider({
 *       getPool: () => dbPool,
 *       cache: redisCache,
 *       resolveBAPId: async (pool, userId, pubkey, register) => {
 *         // Custom BAP ID resolution logic
 *       },
 *     }),
 *   ],
 * });
 * ```
 */
export const sigmaProvider = (
	options?: SigmaProviderOptions,
): BetterAuthPlugin => {
	const debug = createDebugLogger(options?.debug ?? false);

	return {
		id: "sigma",

		schema: {
			user: {
				fields: {
					pubkey: {
						type: "string",
						required: true,
						unique: true,
					},
					...(options?.enableSubscription
						? {
								subscriptionTier: {
									type: "string",
									required: false,
									defaultValue: "free",
								},
							}
						: {}),
				},
			},
			session: {
				fields: {
					...(options?.enableSubscription
						? {
								subscriptionTier: {
									type: "string",
									required: false,
								},
							}
						: {}),
				},
			},
			// Note: selectedBapId removed - use referenceId from oauth-provider instead
			// referenceId is set via postLogin.consentReferenceId callback
			oauthClient: {
				fields: {
					ownerBapId: {
						type: "string",
						required: true,
					},
					memberPubkey: {
						type: "string",
						required: false,
					},
				},
			},
			// Note: oauthConsent selectedBapId removed - use referenceId from oauth-provider instead
			// Note: verification table's updatedAt is in Better Auth core schema - don't extend
		},

		hooks: {
			after: [
				{
					matcher: (ctx) => ctx.path === "/oauth2/token",
					handler: createAuthMiddleware(async (ctx) => {
						debug.log("AFTER hook triggered for /oauth2/token");
						const body = ctx.body as Record<string, unknown>;
						const grantType = body.grant_type as string;

						// Only handle authorization_code grant (not refresh_token)
						if (grantType !== "authorization_code") {
							return;
						}

						// Check if token exchange was successful
						const responseBody = ctx.context.returned;
						if (
							!responseBody ||
							typeof responseBody !== "object" ||
							!("access_token" in responseBody)
						) {
							return; // Token exchange failed, skip profile update
						}

						// Only proceed if we have getPool for profile lookup
						if (!options?.getPool) {
							return;
						}

						try {
							// Get the access token from response to find the token record
							const accessToken = (responseBody as { access_token: string })
								.access_token;

							// Hash the token to match what's stored in the database
							// (oauth-provider uses storeTokens: "hashed" by default)
							const hashedToken = await hashToken(accessToken);

							// Query the access token record to get userId and referenceId
							// referenceId is set by Better Auth via postLogin.consentReferenceId
							// and contains the BAP ID (activeOrganizationId)
							const tokenRecords = await ctx.context.adapter.findMany<{
								userId: string;
								clientId: string;
								token: string;
								referenceId: string | null;
							}>({
								model: "oauthAccessToken",
								where: [{ field: "token", value: hashedToken }],
								limit: 1,
							});

							if (tokenRecords.length === 0 || !tokenRecords[0]) {
								debug.warn("No access token found in database");
								return;
							}

							const { userId, referenceId } = tokenRecords[0];

							// referenceId is the BAP ID (set via postLogin.consentReferenceId from activeOrganizationId)
							if (!referenceId) {
								debug.log(
									"No referenceId (BAP ID) in token, skipping profile update",
								);
								return;
							}

							debug.log(
								`Found BAP ID in token referenceId: user=${userId.substring(0, 15)}... bap=${referenceId.substring(0, 15)}...`,
							);

							// Update user record with selected identity's profile data
							const pool = options.getPool();
							// Use pool.query() directly to avoid connect/release pattern
							// This prevents "Pool release event triggered outside of request scope" warning
							const profileResult = await pool.query<{
								bap_id: string;
								name: string;
								image: string | null;
								member_pubkey: string | null;
							}>(
								"SELECT bap_id, name, image, member_pubkey FROM profile WHERE bap_id = $1 AND user_id = $2 LIMIT 1",
								[referenceId, userId],
							);

							const profile = profileResult.rows[0];
							if (profile) {
								// Only store URL-based images in user record.
								// Data URIs (base64 images) are too large for session cookies
								// and cause 494 REQUEST_HEADER_TOO_LARGE errors on Vercel.
								// Profile images are served via OIDC userinfo claims instead.
								const safeImage =
									profile.image && !profile.image.startsWith("data:")
										? profile.image
										: null;
								if (profile.image && !safeImage) {
									debug.warn(
										`Skipping data URI image for user ${userId.substring(0, 15)}... (${profile.image.length} bytes). ` +
											"Data URI images are too large for session cookies. Use a URL instead.",
									);
								}
								// Update user record with profile data
								await ctx.context.adapter.update({
									model: "user",
									where: [{ field: "id", value: userId }],
									update: {
										name: profile.name,
										image: safeImage,
										...(profile.member_pubkey && {
											pubkey: profile.member_pubkey,
										}),
										updatedAt: new Date(),
									},
								});
								debug.log("Updated user profile from BAP identity");
							}
						} catch (error) {
							debug.error("Error updating user profile from identity:", error);
						}
					}),
				},
				// NOTE: /oauth2/consent hook removed - BAP ID selection now uses:
				// 1. organization.setActive({ organizationId: bapId }) - sets session.activeOrganizationId
				// 2. oauth2Continue({ postLogin: true }) - triggers token issuance
				// 3. postLogin.consentReferenceId returns activeOrganizationId
				// 4. Better Auth stores it in oauthAccessToken.referenceId automatically
			],
			before: [
				{
					matcher: (ctx) => ctx.path === "/oauth2/token",
					handler: createAuthMiddleware(async (ctx) => {
						const body = ctx.body as Record<string, unknown>;
						const grantType = body.grant_type as string;

						// Handle authorization_code grant type (exchange code for token)
						if (grantType === "authorization_code") {
							// Get client_id from request body
							const clientId = body.client_id as string;
							if (!clientId) {
								throw new APIError("BAD_REQUEST", {
									error: "invalid_request",
									error_description: "Missing client_id in request body",
								});
							}

							// Lookup OAuth client by client_id
							const clients = await ctx.context.adapter.findMany({
								model: "oauthClient",
								where: [{ field: "clientId", value: clientId }],
							});

							if (clients.length === 0) {
								throw new APIError("UNAUTHORIZED", {
									error: "invalid_client",
									error_description: `OAuth client not registered: ${clientId}`,
								});
							}

							const client = clients[0] as OAuthClient;

							// Validate client authentication via Bitcoin signature
							const headers = new Headers(ctx.headers || {});
							const authToken = headers.get("x-auth-token");

							if (!authToken) {
								throw new APIError("UNAUTHORIZED", {
									error: "invalid_client",
									error_description:
										"Missing X-Auth-Token header for client authentication",
								});
							}

							// Parse the auth token to extract pubkey
							const parsed = parseAuthToken(authToken);
							if (!parsed?.pubkey) {
								throw new APIError("UNAUTHORIZED", {
									error: "invalid_client",
									error_description:
										"Invalid Bitcoin auth token format - unable to extract pubkey",
								});
							}

							// Verify the pubkey from signature matches the client's registered key
							const expectedPubkey = client.memberPubkey;
							if (!expectedPubkey) {
								throw new APIError("UNAUTHORIZED", {
									error: "invalid_client",
									error_description: `Client ${clientId} has no account pubkey configured`,
								});
							}

							if (parsed.pubkey !== expectedPubkey) {
								throw new APIError("UNAUTHORIZED", {
									error: "invalid_client",
									error_description:
										"Signature pubkey does not match registered member key - check SIGMA_MEMBER_PRIVATE_KEY matches the public key registered for this OAuth client",
								});
							}

							// Get request body for signature verification
							// OAuth standard: token endpoint uses application/x-www-form-urlencoded
							// Reconstruct the URL-encoded string that the client signed
							const bodyParams = new URLSearchParams();
							for (const [key, value] of Object.entries(body)) {
								if (value !== undefined && value !== null) {
									bodyParams.set(key, String(value));
								}
							}
							const bodyString = bodyParams.toString();

							// Verify Bitcoin signature with body
							// Use full path including /api/auth prefix since that's what the client signs
							const verifyData = {
								requestPath: "/api/auth/oauth2/token",
								timestamp: parsed.timestamp,
								body: bodyString,
							};

							const isValid = verifyAuthToken(authToken, verifyData, 5);
							if (!isValid) {
								throw new APIError("UNAUTHORIZED", {
									error: "invalid_client",
									error_description:
										"Bitcoin signature verification failed - signature expired or request body was modified",
								});
							}

							debug.log(
								`Client authenticated via Bitcoin signature (clientId: ${clientId})`,
							);

							// Inject client_id into request body for Better Auth to process
							const modifiedBody = {
								...(ctx.body as Record<string, unknown>),
								client_id: clientId,
							};

							return {
								context: {
									...ctx,
									body: modifiedBody,
								},
							};
						}

						// Handle refresh_token grant type
						if (grantType === "refresh_token") {
							const refreshToken = body.refresh_token as string;

							if (!refreshToken) {
								throw new APIError("BAD_REQUEST", {
									error: "invalid_request",
									error_description: "Missing refresh_token",
								});
							}

							// Get client_id from request body
							const clientId = body.client_id as string;
							if (!clientId) {
								throw new APIError("BAD_REQUEST", {
									error: "invalid_request",
									error_description: "Missing client_id in request body",
								});
							}

							// Lookup OAuth client by client_id
							const clients = await ctx.context.adapter.findMany({
								model: "oauthClient",
								where: [{ field: "clientId", value: clientId }],
							});

							if (clients.length === 0) {
								throw new APIError("UNAUTHORIZED", {
									error: "invalid_client",
									error_description: `OAuth client not registered: ${clientId}`,
								});
							}

							const client = clients[0] as OAuthClient;

							// Validate client signature first
							const headers = new Headers(ctx.headers || {});
							const authToken = headers.get("x-auth-token");

							if (!authToken) {
								throw new APIError("UNAUTHORIZED", {
									error: "invalid_client",
									error_description:
										"Missing X-Auth-Token header for client authentication",
								});
							}

							const parsed = parseAuthToken(authToken);
							if (!parsed?.pubkey) {
								throw new APIError("UNAUTHORIZED", {
									error: "invalid_client",
									error_description:
										"Invalid Bitcoin auth token format - unable to extract pubkey",
								});
							}

							const expectedPubkey = client.memberPubkey;
							if (!expectedPubkey) {
								throw new APIError("UNAUTHORIZED", {
									error: "invalid_client",
									error_description: `Client ${clientId} has no memberPubkey configured`,
								});
							}

							if (parsed.pubkey !== expectedPubkey) {
								throw new APIError("UNAUTHORIZED", {
									error: "invalid_client",
									error_description:
										"Signature pubkey does not match registered member key - check SIGMA_MEMBER_PRIVATE_KEY matches the public key registered for this OAuth client",
								});
							}

							// OAuth standard: token endpoint uses application/x-www-form-urlencoded
							const bodyParams = new URLSearchParams();
							for (const [key, value] of Object.entries(body)) {
								if (value !== undefined && value !== null) {
									bodyParams.set(key, String(value));
								}
							}
							const bodyString = bodyParams.toString();

							const verifyData = {
								requestPath: "/api/auth/oauth2/token",
								timestamp: parsed.timestamp,
								body: bodyString,
							};

							const isValid = verifyAuthToken(authToken, verifyData, 5);
							if (!isValid) {
								throw new APIError("UNAUTHORIZED", {
									error: "invalid_client",
									error_description:
										"Bitcoin signature verification failed - signature expired or request body was modified",
								});
							}

							debug.log(
								`Token refresh: client authenticated via Bitcoin signature (clientId: ${clientId})`,
							);

							// Inject client_id into request body for Better Auth to process
							const modifiedBody = {
								...(ctx.body as Record<string, unknown>),
								client_id: clientId,
							};

							return {
								context: {
									...ctx,
									body: modifiedBody,
								},
							};
						}

						// Unknown grant type
						throw new APIError("BAD_REQUEST", {
							error: "unsupported_grant_type",
							error_description: `Unsupported grant_type: ${grantType}`,
						});
					}),
				},
			],
		},

		endpoints: {
			/**
			 * Store selected BAP ID for OAuth consent
			 *
			 * @deprecated Use organization.setActive({ organizationId: bapId }) followed by
			 * oauth2Continue({ postLogin: true }) instead. The BAP ID is now stored via
			 * postLogin.consentReferenceId which reads from session.activeOrganizationId.
			 *
			 * This endpoint is kept for backwards compatibility during migration.
			 */
			storeConsentBapId: createAuthEndpoint(
				"/sigma/store-consent-bap-id",
				{
					method: "POST",
					body: z.object({
						consentCode: z.string(),
						bapId: z.string(),
					}),
					use: [sessionMiddleware],
				},
				async (ctx) => {
					// Session is guaranteed to exist due to sessionMiddleware
					const _session = ctx.context.session;

					// Validate options
					if (!options?.cache) {
						throw new APIError("INTERNAL_SERVER_ERROR", {
							message: "Plugin configuration error: cache not available",
						});
					}

					const { consentCode, bapId } = ctx.body;

					try {
						// Store in KV with 5 minute TTL
						const kvKey = `consent:${consentCode}:bap_id`;
						await options.cache.set(kvKey, bapId, { ex: 300 });

						debug.warn(
							"DEPRECATED: storeConsentBapId endpoint called. " +
								"Use organization.setActive() + oauth2Continue({ postLogin: true }) instead.",
						);

						return ctx.json({ success: true });
					} catch (error) {
						debug.error("Error storing consent BAP ID selection:", error);
						throw new APIError("INTERNAL_SERVER_ERROR", {
							message: "Failed to store identity selection",
						});
					}
				},
			),

			signInSigma: createAuthEndpoint(
				"/sign-in/sigma",
				{
					method: "POST",
					body: z.optional(
						z.object({
							bapId: z.string().optional(),
						}),
					),
				},
				async (ctx) => {
					// Debug logging for sign-in request
					const allHeaders: Record<string, string> = {};
					ctx.headers?.forEach((value, key) => {
						allHeaders[key] =
							key.toLowerCase() === "x-auth-token"
								? `${value.substring(0, 20)}...` // Truncate sensitive token
								: value;
					});
					debug.log("Sign-in request received", {
						headers: allHeaders,
						body: ctx.body,
						hasAuthToken: !!ctx.headers?.get("x-auth-token"),
					});

					// Get auth token from header
					const authToken = ctx.headers?.get("x-auth-token");
					if (!authToken) {
						throw new APIError("UNAUTHORIZED", {
							message: "No auth token provided",
						});
					}

					// Parse the auth token
					const parsed = parseAuthToken(authToken);
					if (!parsed?.pubkey) {
						throw new APIError("BAD_REQUEST", {
							message: "Invalid auth token format",
						});
					}

					// Verify the auth token
					const verifyData = {
						requestPath: "/api/auth/sign-in/sigma",
						timestamp: parsed.timestamp,
					};

					const isValid = verifyAuthToken(authToken, verifyData, 5);

					if (!isValid) {
						throw new APIError("UNAUTHORIZED", {
							message: "Invalid auth token signature",
						});
					}

					// Extract pubkey from the parsed token
					const pubkey = parsed.pubkey;

					// Find or create user by pubkey
					interface UserWithPubkey extends User {
						pubkey: string;
					}

					// Try to find user by pubkey first
					const users = await ctx.context.adapter.findMany<UserWithPubkey>({
						model: "user",
						where: [{ field: "pubkey", value: pubkey }],
					});

					let user = users[0] as UserWithPubkey | undefined;

					// If not found by user.pubkey, check profile table for member_pubkey
					if (!user && options?.getPool) {
						const pool = options.getPool();
						// Use pool.query() directly to avoid connect/release pattern
						const profileResult = await pool.query<{ user_id: string }>(
							"SELECT user_id FROM profile WHERE member_pubkey = $1 LIMIT 1",
							[pubkey],
						);

						const profileRow = profileResult.rows[0];
						if (profileRow) {
							const userId = profileRow.user_id;

							// Fetch the user record
							const foundUsers =
								await ctx.context.adapter.findMany<UserWithPubkey>({
									model: "user",
									where: [{ field: "id", value: userId }],
								});
							user = foundUsers[0] as UserWithPubkey | undefined;
						}
					}

					if (!user) {
						// Create new user with pubkey (no email)
						try {
							user = (await ctx.context.adapter.create({
								model: "user",
								data: {
									name: PublicKey.fromString(pubkey).toAddress(),
									pubkey,
									emailVerified: false,
									createdAt: new Date(),
									updatedAt: new Date(),
								},
							})) as UserWithPubkey;
						} catch (error: unknown) {
							// If duplicate key error, try to find the user again by pubkey
							if (
								error &&
								typeof error === "object" &&
								"code" in error &&
								error.code === "23505"
							) {
								const existingUsers =
									await ctx.context.adapter.findMany<UserWithPubkey>({
										model: "user",
										where: [{ field: "pubkey", value: pubkey }],
									});

								user = existingUsers[0] as UserWithPubkey | undefined;

								if (!user) {
									throw new APIError("INTERNAL_SERVER_ERROR", {
										message: "User exists but cannot be found",
									});
								}
							} else {
								throw error;
							}
						}
					}

					// Resolve BAP ID if resolver is provided
					if (options?.resolveBAPId && options?.getPool) {
						const pool = options.getPool();

						const bapId = await options.resolveBAPId(
							pool,
							user.id,
							pubkey,
							true,
						);

						if (bapId) {
							debug.log(
								`BAP ID resolved and registered: ${bapId.substring(0, 20)}...`,
							);

							// Ensure a Better Auth organization exists for this BAP identity.
							// Each BAP identity maps to an organization with the user as sole owner.
							const existingOrg = await ctx.context.adapter.findOne<{
								id: string;
							}>({
								model: "organization",
								where: [{ field: "id", value: bapId }],
							});
							if (!existingOrg) {
								await ctx.context.adapter.create({
									model: "organization",
									data: {
										id: bapId,
										name: user.name || bapId,
										slug: bapId,
										createdAt: new Date(),
									},
								});
								await ctx.context.adapter.create({
									model: "member",
									data: {
										organizationId: bapId,
										userId: user.id,
										role: "owner",
										createdAt: new Date(),
									},
								});
								debug.log(
									`Created organization for BAP ID: ${bapId.substring(0, 20)}...`,
								);
							}

							// Update user record with profile data from profile table
							const selectedBapId = ctx.body?.bapId;
							let profileResult: {
								rows: Array<{
									bap_id: string;
									name: string;
									image: string | null;
									member_pubkey: string | null;
								}>;
							};

							if (selectedBapId) {
								// Query profile for selected identity
								// Use pool.query() directly to avoid connect/release pattern
								profileResult = await pool.query<{
									bap_id: string;
									name: string;
									image: string | null;
									member_pubkey: string | null;
								}>(
									"SELECT bap_id, name, image, member_pubkey FROM profile WHERE bap_id = $1 AND user_id = $2 LIMIT 1",
									[selectedBapId, user.id],
								);
							} else {
								// Query for primary profile
								profileResult = await pool.query<{
									bap_id: string;
									name: string;
									image: string | null;
									member_pubkey: string | null;
								}>(
									"SELECT bap_id, name, image, member_pubkey FROM profile WHERE user_id = $1 AND is_primary = true LIMIT 1",
									[user.id],
								);
							}

							const selectedProfile = profileResult.rows[0];
							if (selectedProfile) {
								// Only store URL-based images in user record.
								// Data URIs (base64 images) are too large for session cookies
								// and cause 494 REQUEST_HEADER_TOO_LARGE errors on Vercel.
								// Profile images are served via OIDC userinfo claims instead.
								const safeImage =
									selectedProfile.image &&
									!selectedProfile.image.startsWith("data:")
										? selectedProfile.image
										: null;
								if (selectedProfile.image && !safeImage) {
									debug.warn(
										`Skipping data URI image for user ${user.id.substring(0, 15)}... (${selectedProfile.image.length} bytes). ` +
											"Data URI images are too large for session cookies. Use a URL instead.",
									);
								}
								// Update user record with profile data
								await ctx.context.adapter.update({
									model: "user",
									where: [{ field: "id", value: user.id }],
									update: {
										name: selectedProfile.name,
										image: safeImage,
										...(selectedProfile.member_pubkey && {
											pubkey: selectedProfile.member_pubkey,
										}),
										updatedAt: new Date(),
									},
								});
							}

							// Re-fetch user to get updated profile data
							const updatedUsers =
								await ctx.context.adapter.findMany<UserWithPubkey>({
									model: "user",
									where: [{ field: "id", value: user.id }],
								});
							if (updatedUsers[0]) {
								user = updatedUsers[0];
							}
						}
					}

					// If resolveBAPId didn't run or returned null, but the client
					// sent a bapId (new identity not yet on-chain), ensure the org exists.
					const clientBapId = ctx.body?.bapId;
					if (clientBapId) {
						const existingOrg = await ctx.context.adapter.findOne<{
							id: string;
						}>({
							model: "organization",
							where: [{ field: "id", value: clientBapId }],
						});
						if (!existingOrg) {
							await ctx.context.adapter.create({
								model: "organization",
								data: {
									id: clientBapId,
									name: user.name || clientBapId,
									slug: clientBapId,
									createdAt: new Date(),
								},
							});
							await ctx.context.adapter.create({
								model: "member",
								data: {
									organizationId: clientBapId,
									userId: user.id,
									role: "owner",
									createdAt: new Date(),
								},
							});
							debug.log(
								`Created organization from client bapId: ${clientBapId.substring(0, 20)}...`,
							);
						}
					}

					// Create session
					const session = await ctx.context.internalAdapter.createSession(
						user.id,
					);

					if (!session) {
						throw new APIError("INTERNAL_SERVER_ERROR", {
							message: "Internal Server Error",
							status: 500,
						});
					}

					await setSessionCookie(ctx, { session, user });

					return ctx.json({
						token: session.token,
						user: {
							id: user.id,
							pubkey: user.pubkey,
							name: user.name,
						},
					});
				},
			),
		},
	};
};
