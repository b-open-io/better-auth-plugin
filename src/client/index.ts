import type { BetterFetchOption } from "@better-fetch/fetch";
import type { BetterAuthClientPlugin } from "better-auth/client";
import type {
	OAuthCallbackError,
	OAuthCallbackResult,
	SubscriptionStatus,
} from "../types/index.js";

// Re-export types for convenience
export type {
	OAuthCallbackError,
	OAuthCallbackResult,
	SubscriptionStatus,
} from "../types/index.js";

/**
 * Options for Sigma sign-in
 */
export interface SigmaSignInOptions {
	authToken?: string;
	bapId?: string; // Selected BAP identity ID (for multi-identity wallets)
	callbackURL?: string;
	errorCallbackURL?: string;
	provider?: string;
	clientId?: string;
	disableRedirect?: boolean;
}

// PKCE helper functions
const generateCodeVerifier = () => {
	const array = new Uint8Array(32);
	crypto.getRandomValues(array);
	return btoa(String.fromCharCode(...array))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=/g, "");
};

const generateCodeChallenge = async (verifier: string) => {
	const encoder = new TextEncoder();
	const data = encoder.encode(verifier);
	const hash = await crypto.subtle.digest("SHA-256", data);
	return btoa(String.fromCharCode(...new Uint8Array(hash)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=/g, "");
};

/**
 * Sigma Auth client plugin for Better Auth
 * Provides browser-side OAuth flow with PKCE
 *
 * @example
 * ```typescript
 * import { createAuthClient } from "better-auth/client";
 * import { sigmaClient } from "@sigma-auth/better-auth-plugin/client";
 *
 * export const authClient = createAuthClient({
 *   baseURL: "https://auth.sigmaidentity.com",
 *   plugins: [sigmaClient()],
 * });
 *
 * // Sign in with Sigma
 * authClient.signIn.sigma({
 *   clientId: "your-app",
 *   callbackURL: "/callback",
 * });
 * ```
 */
export const sigmaClient = () => {
	return {
		id: "sigma",

		getActions: ($fetch) => {
			return {
				subscription: {
					getStatus: async (): Promise<SubscriptionStatus> => {
						const res = await $fetch<SubscriptionStatus>(
							"/subscription/status",
							{
								method: "GET",
							},
						);
						if (res.error) {
							throw new Error(
								res.error.message || "Failed to fetch subscription status",
							);
						}
						return res.data as SubscriptionStatus;
					},
				},
				signIn: {
					sigma: async (
						options?: SigmaSignInOptions,
						fetchOptions?: BetterFetchOption,
					) => {
						// Two modes:
						// 1. With authToken: Call local endpoint (for auth server login)
						// 2. Without authToken: OAuth redirect (for external clients)
						if (options?.authToken) {
							// Auth server local sign-in - call endpoint with authToken
							const res = await $fetch("/sign-in/sigma", {
								method: "POST",
								body: {},
								headers: {
									"X-Auth-Token": options.authToken,
								},
								...fetchOptions,
							});
							return res;
						}

						// External OAuth client - redirect to auth server
						const state = Math.random().toString(36).substring(7);

						// Generate PKCE parameters for public clients
						const codeVerifier = generateCodeVerifier();
						const codeChallenge = await generateCodeChallenge(codeVerifier);

						if (typeof window !== "undefined") {
							sessionStorage.setItem("sigma_oauth_state", state);
							sessionStorage.setItem("sigma_code_verifier", codeVerifier);
						}

						const authUrl =
							typeof process !== "undefined"
								? process.env.NEXT_PUBLIC_SIGMA_AUTH_URL ||
									"https://auth.sigmaidentity.com"
								: "https://auth.sigmaidentity.com";

						// Ensure redirect_uri is always absolute (OAuth requires absolute URLs)
						const origin =
							typeof window !== "undefined" ? window.location.origin : "";
						const callbackPath = options?.callbackURL || "/callback";
						const redirectUri = callbackPath.startsWith("http")
							? callbackPath
							: `${origin}${callbackPath.startsWith("/") ? callbackPath : `/${callbackPath}`}`;

						const params = new URLSearchParams({
							redirect_uri: redirectUri,
							response_type: "code",
							state,
							scope: "openid profile bsv:tools",
							code_challenge: codeChallenge,
							code_challenge_method: "S256",
						});

						if (options?.clientId) {
							params.append("client_id", options.clientId);
						}

						if (options?.provider) {
							params.append("provider", options.provider);
						}

						// Use custom authorize endpoint that checks wallet unlock before proceeding
						const fullAuthUrl = `${authUrl}/oauth2/authorize?${params.toString()}`;

						if (typeof window !== "undefined") {
							window.location.href = fullAuthUrl;
						}

						return new Promise(() => {});
					},
				},
				sigma: {
					/**
					 * Handle OAuth callback after redirect from auth server
					 * Verifies state, exchanges code for tokens, and returns user data
					 *
					 * @param searchParams - URL search params from callback (code, state, error)
					 * @returns Promise resolving to user data and tokens
					 * @throws OAuthCallbackError if callback fails
					 */
					handleCallback: async (
						searchParams: URLSearchParams,
					): Promise<OAuthCallbackResult> => {
						// Check for OAuth error
						const error = searchParams.get("error");
						if (error) {
							const errorDescription = searchParams.get("error_description");
							throw {
								title: "Authentication Error",
								message:
									errorDescription ||
									error ||
									"An unknown error occurred during authentication.",
							} as OAuthCallbackError;
						}

						// Check for authorization code
						const code = searchParams.get("code");
						const state = searchParams.get("state");

						if (!code) {
							throw {
								title: "Missing Authorization Code",
								message:
									"The authorization code was not received from the authentication server.",
							} as OAuthCallbackError;
						}

						// Verify state for CSRF protection
						const savedState =
							typeof window !== "undefined"
								? sessionStorage.getItem("sigma_oauth_state")
								: null;

						if (state !== savedState) {
							// Clear invalid state
							if (typeof window !== "undefined") {
								sessionStorage.removeItem("sigma_oauth_state");
							}

							throw {
								title: "Security Error",
								message:
									"Invalid state parameter. Please try signing in again.",
							} as OAuthCallbackError;
						}

						// Clear state after successful verification
						if (typeof window !== "undefined") {
							sessionStorage.removeItem("sigma_oauth_state");
						}

						// Get PKCE verifier
						const codeVerifier =
							typeof window !== "undefined"
								? sessionStorage.getItem("sigma_code_verifier") || undefined
								: undefined;

						// Exchange code for tokens via backend API
						// This must be done server-side because it requires bitcoin-auth signature
						try {
							const response = await fetch("/api/auth/callback", {
								method: "POST",
								headers: {
									"Content-Type": "application/json",
								},
								body: JSON.stringify({
									code,
									state,
									code_verifier: codeVerifier,
								}),
							});

							if (!response.ok) {
								let errorMessage =
									"Failed to exchange authorization code for access token.";
								let errorTitle = "Token Exchange Failed";

								try {
									const errorData = (await response.json()) as {
										endpoint?: string;
										status?: number;
										details?: string;
										error?: string;
									};
									const endpoint = errorData.endpoint || "unknown";
									const status = errorData.status || response.status;

									// Parse nested error details if present
									if (errorData.details) {
										try {
											const nestedError = JSON.parse(errorData.details) as {
												error_description?: string;
												error?: string;
											};
											if (nestedError.error_description) {
												errorMessage = nestedError.error_description;
											}
											if (nestedError.error === "invalid_client") {
												errorTitle = "Platform Not Registered";
												errorMessage =
													"This platform is not registered with the authentication server.";
											}
										} catch {
											errorMessage = errorData.details;
										}
									} else if (errorData.error) {
										errorMessage = errorData.error;
									}

									errorMessage += `\n\nBackend: ${status} (${endpoint})`;
								} catch {
									// Use default error message
								}

								throw {
									title: errorTitle,
									message: errorMessage,
								} as OAuthCallbackError;
							}

							const data = (await response.json()) as OAuthCallbackResult;
							return {
								user: data.user,
								access_token: data.access_token,
								refresh_token: data.refresh_token,
							};
						} catch (err) {
							// If already an OAuthCallbackError, rethrow
							if (
								typeof err === "object" &&
								err !== null &&
								"title" in err &&
								"message" in err
							) {
								throw err;
							}

							// Otherwise wrap in error object
							throw {
								title: "Authentication Failed",
								message:
									err instanceof Error
										? err.message
										: "An unknown error occurred.",
							} as OAuthCallbackError;
						}
					},
				},
			};
		},
	} satisfies BetterAuthClientPlugin;
};
