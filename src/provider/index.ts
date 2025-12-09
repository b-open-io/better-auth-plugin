import { PublicKey } from "@bsv/sdk";
import type { Pool } from "@neondatabase/serverless";
import type { BetterAuthPlugin, User } from "better-auth";
import {
	APIError,
	createAuthEndpoint,
	sessionMiddleware,
} from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { createAuthMiddleware } from "better-auth/plugins";
import { parseAuthToken, verifyAuthToken } from "bitcoin-auth";
import { z } from "zod";

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
 * OAuth client type with Sigma metadata
 * Note: Better Auth stores metadata as a JSON string, not jsonb
 */
interface OAuthClient {
	clientId: string;
	metadata?: string; // JSON string from Better Auth
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
			oauthAccessToken: {
				fields: {
					selectedBapId: {
						type: "string",
						required: false,
					},
				},
			},
			oauthApplication: {
				fields: {
					owner_bap_id: {
						type: "string",
						required: true,
					},
				},
			},
			oauthConsent: {
				fields: {
					selectedBapId: {
						type: "string",
						required: false,
					},
				},
			},
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
							return; // Token exchange failed, skip BAP ID storage
						}

						// Only proceed if we have cache option
						if (!options?.cache) {
							return;
						}

						try {
							// Get the access token from response to find the related consent
							const accessToken = (responseBody as { access_token: string })
								.access_token;

							// Query the access token record to get userId and clientId using adapter
							const tokenRecords = await ctx.context.adapter.findMany<{
								userId: string;
								clientId: string;
								accessToken: string;
							}>({
								model: "oauthAccessToken",
								where: [{ field: "accessToken", value: accessToken }],
								limit: 1,
							});

							if (tokenRecords.length === 0 || !tokenRecords[0]) {
								debug.warn("No access token found in database");
								return;
							}

							const { userId, clientId } = tokenRecords[0];

							// Query the most recent consent record for this user/client to get selectedBapId
							const consentRecords = await ctx.context.adapter.findMany<{
								selectedBapId: string;
								userId: string;
								clientId: string;
								createdAt: Date;
							}>({
								model: "oauthConsent",
								where: [
									{ field: "userId", value: userId },
									{ field: "clientId", value: clientId },
								],
								limit: 1,
								sortBy: { field: "createdAt", direction: "desc" },
							});

							const consentRecord = consentRecords[0];
							if (!consentRecord || !consentRecord.selectedBapId) {
								return;
							}

							const selectedBapId = consentRecord.selectedBapId;

							// Update the oauthAccessToken record with the selected BAP ID
							await ctx.context.adapter.update({
								model: "oauthAccessToken",
								where: [{ field: "accessToken", value: accessToken }],
								update: {
									selectedBapId,
								},
							});

							debug.log(
								`Stored BAP ID in access token: user=${userId.substring(0, 15)}... bap=${selectedBapId.substring(0, 15)}...`,
							);

							// Update user record with selected identity's profile data
							if (options?.getPool) {
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
									[selectedBapId, userId],
								);

								const profile = profileResult.rows[0];
								if (profile) {
									// Update user record with profile data
									await ctx.context.adapter.update({
										model: "user",
										where: [{ field: "id", value: userId }],
										update: {
											name: profile.name,
											image: profile.image,
											...(profile.member_pubkey && {
												pubkey: profile.member_pubkey,
											}),
											updatedAt: new Date(),
										},
									});
								}
							}
						} catch (error) {
							debug.error("Error storing identity selection:", error);
						}
					}),
				},
				// NOTE: Userinfo enrichment is handled by getAdditionalUserInfoClaim in auth server config
				// This avoids duplicate database queries and pool release warnings
				// The auth server's getAdditionalUserInfoClaim looks up selectedBapId and fetches BAP profile
				{
					matcher: (ctx) => ctx.path === "/oauth2/consent",
					handler: createAuthMiddleware(async (ctx) => {
						// Only proceed if we have cache option
						if (!options?.cache) {
							return;
						}

						const body = ctx.body as Record<string, unknown>;
						const consentCode = body.consent_code as string;
						const accept = body.accept as boolean;

						// Only store selectedBapId if consent was accepted
						if (!accept || !consentCode) {
							return;
						}

						try {
							// Get session for userId
							const session = ctx.context.session;
							if (!session?.user?.id) {
								return;
							}

							// Wait a bit for Better Auth to create the consent record
							await new Promise((resolve) => setTimeout(resolve, 100));

							// Query the database to get the clientId from the consent record
							const consentRecords = await ctx.context.adapter.findMany<{
								id: string;
								clientId: string;
								userId: string;
								createdAt: Date;
							}>({
								model: "oauthConsent",
								where: [{ field: "userId", value: session.user.id }],
								limit: 1,
								sortBy: { field: "createdAt", direction: "desc" },
							});

							const consentRecord = consentRecords[0];
							if (!consentRecord) {
								return;
							}

							const { id: consentId } = consentRecord;

							// Retrieve selected BAP ID from cache/KV
							const selectedBapId = await options.cache.get<string>(
								`consent:${consentCode}:bap_id`,
							);

							if (!selectedBapId) {
								return;
							}

							// Update the consent record with selectedBapId using adapter
							await ctx.context.adapter.update({
								model: "oauthConsent",
								where: [{ field: "id", value: consentId }],
								update: {
									selectedBapId,
								},
							});

							debug.log(
								`Stored BAP ID in consent: user=${session.user.id.substring(0, 15)}... bap=${selectedBapId.substring(0, 15)}...`,
							);
						} catch (error) {
							debug.error("Error storing consent identity selection:", error);
						}
					}),
				},
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
									message: "Missing client_id in request body",
								});
							}

							// Lookup OAuth client by client_id
							const clients = await ctx.context.adapter.findMany({
								model: "oauthApplication",
								where: [{ field: "clientId", value: clientId }],
							});

							if (clients.length === 0) {
								throw new APIError("UNAUTHORIZED", {
									message: `OAuth client not registered: ${clientId}`,
								});
							}

							const client = clients[0] as OAuthClient;

							// Validate client authentication via Bitcoin signature
							const headers = new Headers(ctx.headers || {});
							const authToken = headers.get("x-auth-token");

							if (!authToken) {
								throw new APIError("UNAUTHORIZED", {
									message:
										"Missing X-Auth-Token header for client authentication",
								});
							}

							// Parse the auth token to extract pubkey
							const parsed = parseAuthToken(authToken);
							if (!parsed?.pubkey) {
								throw new APIError("UNAUTHORIZED", {
									message: "Invalid Bitcoin auth token format",
								});
							}

							// Verify the pubkey from signature matches the client's memberPubkey
							if (!client.metadata) {
								throw new APIError("UNAUTHORIZED", {
									message: `Client ${clientId} has no metadata`,
								});
							}

							const metadata = JSON.parse(client.metadata) as {
								memberPubkey?: string;
							};
							const expectedPubkey = metadata.memberPubkey;

							if (!expectedPubkey) {
								throw new APIError("UNAUTHORIZED", {
									message: `Client ${clientId} has no memberPubkey in metadata`,
								});
							}

							if (parsed.pubkey !== expectedPubkey) {
								throw new APIError("UNAUTHORIZED", {
									message: "Bitcoin signature pubkey does not match client",
								});
							}

							// Get request body for signature verification
							// Client sends JSON body, so we verify against the JSON string
							const bodyString = JSON.stringify(body);

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
									message: "Invalid Bitcoin signature",
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
									message: "Missing refresh_token",
								});
							}

							// Get client_id from request body
							const clientId = body.client_id as string;
							if (!clientId) {
								throw new APIError("BAD_REQUEST", {
									message: "Missing client_id in request body",
								});
							}

							// Lookup OAuth client by client_id
							const clients = await ctx.context.adapter.findMany({
								model: "oauthApplication",
								where: [{ field: "clientId", value: clientId }],
							});

							if (clients.length === 0) {
								throw new APIError("UNAUTHORIZED", {
									message: `OAuth client not registered: ${clientId}`,
								});
							}

							const client = clients[0] as OAuthClient;

							// Validate client signature first
							const headers = new Headers(ctx.headers || {});
							const authToken = headers.get("x-auth-token");

							if (!authToken) {
								throw new APIError("UNAUTHORIZED", {
									message:
										"Missing X-Auth-Token header for client authentication",
								});
							}

							const parsed = parseAuthToken(authToken);
							if (!parsed?.pubkey) {
								throw new APIError("UNAUTHORIZED", {
									message: "Invalid Bitcoin auth token format",
								});
							}

							if (!client.metadata) {
								throw new APIError("UNAUTHORIZED", {
									message: `Client ${clientId} has no metadata`,
								});
							}

							const metadata = JSON.parse(client.metadata) as {
								memberPubkey?: string;
							};
							const expectedPubkey = metadata.memberPubkey;

							if (!expectedPubkey) {
								throw new APIError("UNAUTHORIZED", {
									message: `Client ${clientId} has no memberPubkey in metadata`,
								});
							}

							if (parsed.pubkey !== expectedPubkey) {
								throw new APIError("UNAUTHORIZED", {
									message: "Bitcoin signature pubkey does not match client",
								});
							}

							// Client sends JSON body, so we verify against the JSON string
							const bodyString = JSON.stringify(body);

							const verifyData = {
								requestPath: "/api/auth/oauth2/token",
								timestamp: parsed.timestamp,
								body: bodyString,
							};

							const isValid = verifyAuthToken(authToken, verifyData, 5);
							if (!isValid) {
								throw new APIError("UNAUTHORIZED", {
									message: "Invalid Bitcoin signature",
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
							message: `Unsupported grant_type: ${grantType}`,
						});
					}),
				},
			],
		},

		endpoints: {
			/**
			 * Store selected BAP ID for OAuth consent
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
								// Update user record with profile data
								await ctx.context.adapter.update({
									model: "user",
									where: [{ field: "id", value: user.id }],
									update: {
										name: selectedProfile.name,
										image: selectedProfile.image,
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
