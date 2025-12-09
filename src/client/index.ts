import type { BetterFetchOption } from "@better-fetch/fetch";
import type { BetterAuthClientPlugin } from "better-auth/client";
import type {
	OAuthCallbackError,
	OAuthCallbackResult,
	SubscriptionStatus,
} from "../types/index.js";
import { SigmaIframeSigner } from "./signer.js";

// Re-export types for convenience
export type {
	OAuthCallbackError,
	OAuthCallbackResult,
	SubscriptionStatus,
} from "../types/index.js";

// Module-level state for signer (singleton per page)
let signer: SigmaIframeSigner | null = null;
let storedBapId: string | null = null;

// Storage key for persisting bapId
const BAP_ID_STORAGE_KEY = "sigma_bap_id";

/**
 * Get the Sigma auth URL from environment or default
 */
const getSigmaUrl = (): string => {
	if (
		typeof process !== "undefined" &&
		process.env.NEXT_PUBLIC_SIGMA_AUTH_URL
	) {
		return process.env.NEXT_PUBLIC_SIGMA_AUTH_URL;
	}
	return "https://auth.sigmaidentity.com";
};

/**
 * Initialize or get the signer instance (lazy singleton)
 */
const getOrCreateSigner = async (): Promise<SigmaIframeSigner> => {
	if (!signer) {
		signer = new SigmaIframeSigner(getSigmaUrl());
	}
	if (!signer.isReady()) {
		await signer.init();
	}
	return signer;
};

/**
 * Load bapId from storage on init
 */
const loadStoredBapId = (): string | null => {
	if (typeof window === "undefined") return null;
	if (storedBapId) return storedBapId;

	const stored = localStorage.getItem(BAP_ID_STORAGE_KEY);
	if (stored) {
		storedBapId = stored;
	}
	return storedBapId;
};

/**
 * Options for Sigma sign-in (OAuth redirect mode)
 * When authToken is NOT provided, clientId is REQUIRED for OAuth flow
 */
export interface SigmaSignInOptions {
	/** Auth token for direct sign-in (auth server only) */
	authToken?: string;
	/** Selected BAP identity ID (for multi-identity wallets) */
	bapId?: string;
	/** Callback URL after OAuth redirect (default: /callback) */
	callbackURL?: string;
	/** Error callback URL */
	errorCallbackURL?: string;
	/** OAuth provider (e.g., 'github', 'google') */
	provider?: string;
	/**
	 * OAuth client ID - REQUIRED for OAuth redirect flow
	 * Get this from your OAuth client registration
	 */
	clientId?: string;
	/** Disable automatic redirect (for testing) */
	disableRedirect?: boolean;
	/**
	 * Better Auth's proxy extracts fetchOptions before creating body
	 * Use this to pass custom headers (like X-Auth-Token) through the proxy
	 */
	fetchOptions?: BetterFetchOption;
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
 * ARCHITECTURE: FRONTING BETTER AUTH'S OIDC PROVIDER
 * ===================================================
 * This plugin intentionally fronts Better Auth's OIDC authorize endpoint by
 * redirecting to `/oauth2/authorize` instead of `/api/auth/oauth2/authorize`.
 *
 * Why we front the endpoint:
 * - Wallet access is a prerequisite to authentication in Sigma Identity
 * - Better Auth's OIDC provider handles standard OAuth flows (session, consent)
 * - But it doesn't know about Bitcoin wallet unlock requirements
 * - Our custom gate at `/oauth2/authorize` checks wallet status BEFORE
 *   forwarding to Better Auth's real endpoint
 *
 * The flow:
 * 1. Client calls `/oauth2/authorize` (custom gate)
 * 2. Gate checks: session → local backup → cloud backup → signup
 * 3. If wallet not accessible, prompts user to unlock it
 * 4. Once wallet is accessible, forwards to Better Auth's `/api/auth/oauth2/authorize`
 * 5. Better Auth handles standard OAuth (session validation, consent, authorization code)
 *
 * This ensures that wallet access is always verified before any OAuth flow completes,
 * making Bitcoin identity the foundation of authentication.
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
							// Auth server local sign-in - call endpoint with authToken in header
							// IMPORTANT: Spread fetchOptions FIRST so our explicit values override
							const res = await $fetch("/sign-in/sigma", {
								...fetchOptions,
								method: "POST",
								body: {}, // Explicit empty body - authToken goes in header, not body
								headers: {
									...(fetchOptions?.headers as Record<string, string>),
									"X-Auth-Token": options.authToken,
								},
							});
							return res;
						}

						// External OAuth client - redirect to auth server
						// Validate required clientId for OAuth flow
						if (!options?.clientId) {
							throw new Error(
								"[Sigma Auth] clientId is required for OAuth flow. " +
								"Pass clientId in signIn.sigma({ clientId: 'your-app', ... }) or set NEXT_PUBLIC_SIGMA_CLIENT_ID environment variable."
							);
						}

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
							client_id: options.clientId,
							redirect_uri: redirectUri,
							response_type: "code",
							state,
							scope: "openid profile bsv:tools",
							code_challenge: codeChallenge,
							code_challenge_method: "S256",
						});

						if (options?.provider) {
							params.append("provider", options.provider);
						}

						// IMPORTANT: Use custom authorize endpoint that FRONTS Better Auth
						// This gate ensures wallet access before OAuth completion
						// See /app/oauth2/authorize/page.tsx on auth server for implementation
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

							// Store bapId from user data for signing (from bap_id claim)
							const bapId = data.user?.bap_id;
							if (bapId) {
								storedBapId = bapId;
								if (typeof window !== "undefined") {
									localStorage.setItem(BAP_ID_STORAGE_KEY, bapId);
								}
							}

							return {
								user: data.user,
								access_token: data.access_token,
								id_token: data.id_token,
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

					/**
					 * Sign a request using the Sigma iframe signer
					 * Keys stay in Sigma's domain - only the signature is returned
					 *
					 * @param requestPath - The API path being signed (e.g., "/api/droplits")
					 * @param body - Optional request body (string or object)
					 * @param signatureType - Signature type: 'bsm' or 'brc77' (default: 'brc77')
					 * @returns Promise resolving to auth token string
					 * @throws Error if no identity set or signing fails
					 *
					 * @example
					 * ```typescript
					 * const authToken = await authClient.sigma.sign("/api/droplits", { name: "test" });
					 * fetch("/api/droplits", {
					 *   headers: { "X-Auth-Token": authToken }
					 * });
					 * ```
					 */
					sign: async (
						requestPath: string,
						body?: string | object,
						signatureType: "bsm" | "brc77" = "brc77",
					): Promise<string> => {
						// Ensure we have a bapId (from callback or storage)
						const bapId = storedBapId || loadStoredBapId();
						if (!bapId) {
							throw new Error(
								"No identity set. Complete OAuth login first or call setIdentity().",
							);
						}

						const signerInstance = await getOrCreateSigner();
						signerInstance.setIdentity(bapId);

						// Serialize body if object
						const bodyString =
							body && typeof body === "object" ? JSON.stringify(body) : body;

						return signerInstance.sign(requestPath, bodyString, signatureType);
					},

					/**
					 * Sign OP_RETURN data with AIP for Bitcoin transactions
					 * Keys stay in Sigma's domain - only the signed ops are returned
					 *
					 * @param hexArray - Array of hex strings to sign
					 * @returns Promise resolving to array of signed hex strings
					 * @throws Error if no identity set or signing fails
					 *
					 * @example
					 * ```typescript
					 * const signedOps = await authClient.sigma.signAIP(["6a", "..."]);
					 * ```
					 */
					signAIP: async (hexArray: string[]): Promise<string[]> => {
						const bapId = storedBapId || loadStoredBapId();
						if (!bapId) {
							throw new Error(
								"No identity set. Complete OAuth login first or call setIdentity().",
							);
						}

						const signerInstance = await getOrCreateSigner();
						signerInstance.setIdentity(bapId);

						return signerInstance.signAIP(hexArray);
					},

					/**
					 * Get the current identity (BAP ID) being used for signing
					 * @returns The current bapId or null if not set
					 */
					getIdentity: (): string | null => {
						return storedBapId || loadStoredBapId();
					},

					/**
					 * Set the identity (BAP ID) to use for signing
					 * This is typically set automatically from OAuth callback,
					 * but can be set manually for multi-identity scenarios
					 *
					 * @param bapId - The BAP identity ID to use
					 */
					setIdentity: (bapId: string): void => {
						storedBapId = bapId;
						if (typeof window !== "undefined") {
							localStorage.setItem(BAP_ID_STORAGE_KEY, bapId);
						}
						// If signer already exists, update it
						if (signer) {
							signer.setIdentity(bapId);
						}
					},

					/**
					 * Clear the stored identity and destroy the signer
					 * Call this on logout
					 */
					clearIdentity: (): void => {
						storedBapId = null;
						if (typeof window !== "undefined") {
							localStorage.removeItem(BAP_ID_STORAGE_KEY);
						}
						if (signer) {
							signer.destroy();
							signer = null;
						}
					},

					/**
					 * Check if the signer is ready for signing
					 * @returns true if identity is set and signer is initialized
					 */
					isReady: (): boolean => {
						const bapId = storedBapId || loadStoredBapId();
						return !!bapId;
					},
				},
			};
		},
	} satisfies BetterAuthClientPlugin;
};
