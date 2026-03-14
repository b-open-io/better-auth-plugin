import type { BetterAuthPlugin, User } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { z } from "zod";
import type { BAPProfile } from "../types/index.js";
import { exchangeCodeForTokens } from "./index.js";

/**
 * Options for the sigmaCallbackPlugin
 * All values fall back to environment variables if not provided
 */
export interface SigmaCallbackOptions {
	/** Account private key (WIF) for signing token exchange. Default: SIGMA_MEMBER_PRIVATE_KEY env */
	accountPrivateKey?: string;
	/** OAuth client ID. Default: NEXT_PUBLIC_SIGMA_CLIENT_ID env */
	clientId?: string;
	/** Sigma Auth server URL. Default: NEXT_PUBLIC_SIGMA_AUTH_URL or https://auth.sigmaidentity.com */
	issuerUrl?: string;
	/** OAuth callback path. Default: /auth/sigma/callback */
	callbackPath?: string;
	/** Email domain for generated emails when user has no email. Default: sigma.local */
	emailDomain?: string;
}

/**
 * Better Auth server-side plugin that handles the Sigma OAuth callback.
 *
 * Registers POST /sigma/callback which:
 * 1. Exchanges authorization code for tokens (via bitcoin-auth signed request)
 * 2. Finds or creates user in Better Auth database
 * 3. Creates/updates account record (providerId: "sigma")
 * 4. Creates session and sets cookie
 *
 * Works in any Better Auth environment (Convex, Prisma, standalone).
 * No local Auth instance needed — runs inside Better Auth via createAuthEndpoint.
 *
 * @example
 * ```typescript
 * import { sigmaCallbackPlugin } from "@sigma-auth/better-auth-plugin/server";
 *
 * // Convex
 * export const createAuth = (ctx) => betterAuth({
 *   plugins: [convex({ authConfig }), sigmaCallbackPlugin()],
 * });
 *
 * // Standalone
 * export const auth = betterAuth({
 *   plugins: [sigmaCallbackPlugin({ accountPrivateKey: "..." })],
 * });
 * ```
 */
export function sigmaCallbackPlugin(
	options?: SigmaCallbackOptions,
): BetterAuthPlugin {
	return {
		id: "sigma-callback",
		endpoints: {
			sigmaCallback: createAuthEndpoint(
				"/sigma/callback",
				{
					method: "POST",
					body: z.object({
						code: z.string(),
						state: z.string().optional(),
						code_verifier: z.string().optional(),
						redirect_uri: z.string().optional(),
					}),
				},
				async (ctx) => {
					// 1. Read config from options or env vars
					const accountPrivateKey =
						options?.accountPrivateKey || process.env.SIGMA_MEMBER_PRIVATE_KEY;
					if (!accountPrivateKey) {
						throw new APIError("INTERNAL_SERVER_ERROR", {
							message: "SIGMA_MEMBER_PRIVATE_KEY not configured",
						});
					}

					const clientId =
						options?.clientId || process.env.NEXT_PUBLIC_SIGMA_CLIENT_ID;
					if (!clientId) {
						throw new APIError("INTERNAL_SERVER_ERROR", {
							message: "NEXT_PUBLIC_SIGMA_CLIENT_ID not configured",
						});
					}

					const issuerUrl =
						options?.issuerUrl ||
						process.env.NEXT_PUBLIC_SIGMA_AUTH_URL ||
						"https://auth.sigmaidentity.com";

					const callbackPath = options?.callbackPath || "/auth/sigma/callback";
					const emailDomain = options?.emailDomain || "sigma.local";

					console.log(
						"[Sigma Callback Plugin] Config: clientId=%s, issuerUrl=%s",
						clientId,
						issuerUrl,
					);

					// 2. Build redirect_uri
					// Preferred: accept from client (they know the real origin)
					// Fallback: reconstruct from request headers or baseURL
					let redirectUri = ctx.body.redirect_uri;
					const forwardedHost = ctx.headers?.get("x-forwarded-host");
					if (!redirectUri) {
						const forwardedProto =
							ctx.headers?.get("x-forwarded-proto") || "https";
						let origin: string;
						if (forwardedHost) {
							origin = `${forwardedProto}://${forwardedHost}`;
						} else {
							origin = ctx.context.baseURL;
						}
						redirectUri = `${origin}${callbackPath}`;
					}

					console.log(
						"[Sigma Callback Plugin] redirect_uri=%s (source: %s)",
						redirectUri,
						ctx.body.redirect_uri
							? "body"
							: forwardedHost
								? "x-forwarded-host"
								: "baseURL",
					);

					// 3. Exchange code for tokens
					const result = await exchangeCodeForTokens({
						code: ctx.body.code,
						redirectUri,
						clientId,
						accountPrivateKey,
						codeVerifier: ctx.body.code_verifier,
						issuerUrl,
					});

					// 4. Extract user info
					// bap field may be a JSON string (from JWT) — parse if needed
					let bap: BAPProfile | null = null;
					if (typeof result.user.bap === "string") {
						try {
							bap = JSON.parse(result.user.bap) as BAPProfile;
						} catch {
							// Malformed BAP JSON in token — fall back to null
						}
					} else {
						bap = result.user.bap ?? null;
					}

					const bapId = result.user.bap_id || bap?.bapId;

					console.log(
						"[Sigma Callback Plugin] Token exchange success: sub=%s, bapId=%s",
						result.user.sub,
						bapId?.substring(0, 20) || "none",
					);

					const email =
						result.user.email || `${bapId || result.user.sub}@${emailDomain}`;
					const name =
						result.user.name || bap?.identity?.alternateName || "User";
					const image =
						result.user.picture || bap?.identity?.image || undefined;

					// 5. Find or create user
					const { adapter, internalAdapter } = ctx.context;

					// Try by email first (use findMany + [0] like sigmaProvider does)
					const existingUsers = await adapter.findMany<User>({
						model: "user",
						where: [{ field: "email", value: email }],
					});

					let user = existingUsers[0] as User | undefined;
					let isNewUser = false;

					if (user) {
						// Update with latest profile data
						await adapter.update({
							model: "user",
							where: [{ field: "id", value: user.id }],
							update: {
								name,
								image,
								updatedAt: new Date(),
							},
						});
					} else {
						// Create new user
						user = (await adapter.create({
							model: "user",
							data: {
								email,
								name,
								image,
								emailVerified: true,
								createdAt: new Date(),
								updatedAt: new Date(),
							},
						})) as User;
						isNewUser = true;
					}

					console.log(
						"[Sigma Callback Plugin] User %s: id=%s, email=%s",
						isNewUser ? "created" : "found",
						user.id,
						email,
					);

					// 6. Create/update account record
					const sigmaAccountId = result.user.sub;
					const accountsByAccountId = await adapter.findMany<{
						id: string;
						providerId: string;
					}>({
						model: "account",
						where: [{ field: "accountId", value: sigmaAccountId }],
					});
					const existingAccount = accountsByAccountId.find(
						(a) => a.providerId === "sigma",
					);
					const now = new Date();
					const accessTokenExpiresAt = result.expires_in
						? new Date(Date.now() + result.expires_in * 1000)
						: undefined;

					if (existingAccount) {
						await adapter.update({
							model: "account",
							where: [{ field: "id", value: existingAccount.id }],
							update: {
								accessToken: result.access_token,
								refreshToken: result.refresh_token,
								idToken: result.id_token,
								...(accessTokenExpiresAt && { accessTokenExpiresAt }),
								updatedAt: now,
							},
						});
					} else {
						await adapter.create({
							model: "account",
							data: {
								accountId: sigmaAccountId,
								providerId: "sigma",
								userId: user.id,
								accessToken: result.access_token,
								refreshToken: result.refresh_token,
								idToken: result.id_token,
								...(accessTokenExpiresAt && { accessTokenExpiresAt }),
								createdAt: now,
								updatedAt: now,
							},
						});
					}

					// 7. Create session
					const session = await internalAdapter.createSession(user.id);

					if (!session) {
						throw new APIError("INTERNAL_SERVER_ERROR", {
							message: "Failed to create session",
						});
					}

					// 8. Set session cookie
					await setSessionCookie(ctx, { session, user });

					// 9. Return response
					return ctx.json({
						user: {
							...result.user,
							sub: user.id,
						},
						access_token: result.access_token,
						id_token: result.id_token,
						refresh_token: result.refresh_token,
						expires_in: result.expires_in,
						userId: user.id,
						isNewUser,
					});
				},
			),
		},
	};
}
