import type { BetterFetchOption } from "@better-fetch/fetch";
import type { BetterAuthClientPlugin } from "better-auth/client";
// Import organizationClient from dedicated path for tree-shaking (per Better Auth best practices)
import { organizationClient } from "better-auth/client/plugins";
import type {
	ConnectedWallet,
	NFTListResponse,
	NFTOwnershipResponse,
	OAuthCallbackError,
	OAuthCallbackResult,
	SubscriptionStatus,
	SubscriptionTier,
} from "../types/index.js";
import {
	LocalServerSigner,
	type LocalServerSignerOptions,
	type SigmaSigner,
} from "./local-signer.js";
import { SigmaIframeSigner } from "./signer.js";

// Re-export types for convenience
export type {
	BAPProfile,
	ConnectedWallet,
	NFT,
	NFTListResponse,
	NFTOwnershipResponse,
	OAuthCallbackError,
	OAuthCallbackResult,
	SigmaJWTPayload,
	SigmaUserInfo,
	SubscriptionStatus,
	SubscriptionTier,
	WalletNFTs,
} from "../types/index.js";

// Re-export signer types and classes
export { LocalServerSigner, type SigmaSigner } from "./local-signer.js";
export { SigmaIframeSigner } from "./signer.js";

// Re-export organizationClient for consumers using BAP identities as organizations
// Usage: createAuthClient({ plugins: [sigmaClient(), organizationClient()] })
export { organizationClient };

// Module-level state for signer (singleton per page)
let signer: SigmaSigner | null = null;
let signerType: "local" | "iframe" | null = null;
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
 * Get the local server URL from environment or default
 */
const getLocalServerUrl = (): string => {
	if (typeof process !== "undefined" && process.env.NEXT_PUBLIC_TOKENPASS_URL) {
		return process.env.NEXT_PUBLIC_TOKENPASS_URL;
	}
	return "http://localhost:21000";
};

// Module-level options for server detection
let preferLocalServer = false;
let localServerOptions: LocalServerSignerOptions = {};
let serverDetectedCallback:
	| ((url: string, isLocal: boolean) => void)
	| undefined;

/**
 * Initialize or get the signer instance (lazy singleton)
 * Will prefer local server if configured and available
 */
const getOrCreateSigner = async (): Promise<SigmaSigner> => {
	if (signer?.isReady()) {
		return signer;
	}

	// If we prefer local and haven't tried yet, check for local server
	if (preferLocalServer && signerType !== "iframe") {
		const localSigner = new LocalServerSigner({
			baseUrl: localServerOptions.baseUrl || getLocalServerUrl(),
			timeout: localServerOptions.timeout,
		});

		if (await localSigner.probe()) {
			// Local server is available
			signer = localSigner;
			signerType = "local";
			serverDetectedCallback?.(localSigner.getBaseUrl(), true);

			// Try to authenticate with current host
			const host =
				typeof window !== "undefined" ? window.location.host : "localhost";
			await localSigner.authenticate(host);

			return signer;
		}
	}

	// Fall back to iframe signer (cloud)
	if (!signer || signerType !== "iframe") {
		const iframeSigner = new SigmaIframeSigner(getSigmaUrl());
		signer = iframeSigner;
		signerType = "iframe";
		serverDetectedCallback?.(getSigmaUrl(), false);
	}

	const iframeSigner = signer as SigmaIframeSigner;
	if (!iframeSigner.isReady()) {
		await iframeSigner.init();
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
	/** Callback URL after OAuth redirect (default: /auth/sigma/callback) */
	callbackURL?: string;
	/** Error callback URL (default: /auth/sigma/error) */
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
	 * Force OAuth redirect even if already signed in.
	 * By default, if a session exists, signIn.sigma() returns it without redirecting.
	 */
	forceLogin?: boolean;
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
 * Options for the Sigma client plugin
 */
export interface SigmaClientOptions {
	/**
	 * Prefer local TokenPass server over cloud iframe signer.
	 * If true, the client will probe for a local server first
	 * and only fall back to cloud if unavailable.
	 * Default: false
	 */
	preferLocal?: boolean;

	/**
	 * Local server URL (default: http://localhost:21000)
	 * Can also be set via NEXT_PUBLIC_TOKENPASS_URL env var
	 */
	localServerUrl?: string;

	/**
	 * Timeout for local server requests in milliseconds (default: 5000)
	 */
	localServerTimeout?: number;

	/**
	 * Callback when server type is detected
	 * @param url - The server URL being used
	 * @param isLocal - True if using local server, false if cloud
	 */
	onServerDetected?: (url: string, isLocal: boolean) => void;
}

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
 *   plugins: [sigmaClient({ preferLocal: true })],
 * });
 *
 * // Sign in with Sigma
 * authClient.signIn.sigma({
 *   clientId: "your-app",
 *   callbackURL: "/callback",
 * });
 * ```
 */
export const sigmaClient = (options: SigmaClientOptions = {}) => {
	// Configure module-level options for signer detection
	preferLocalServer = options.preferLocal ?? false;
	localServerOptions = {
		baseUrl: options.localServerUrl,
		timeout: options.localServerTimeout,
	};
	serverDetectedCallback = options.onServerDetected;
	return {
		id: "sigma",

		getActions: ($fetch, $store) => {
			return {
				subscription: {
					/**
					 * Get current subscription status based on NFT ownership
					 */
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

					/**
					 * Check if current tier meets minimum requirement
					 */
					hasTier: (
						currentTier: SubscriptionTier,
						requiredTier: SubscriptionTier,
					): boolean => {
						const tierPriority: Record<SubscriptionTier, number> = {
							free: 0,
							plus: 1,
							pro: 2,
							premium: 3,
							enterprise: 4,
						};
						return tierPriority[currentTier] >= tierPriority[requiredTier];
					},
				},
				wallet: {
					/**
					 * Get connected wallets for a BAP ID
					 * @param bapId - The BAP ID to get wallets for (optional, defaults to session user)
					 */
					getConnected: async (
						bapId?: string,
					): Promise<{ wallets: ConnectedWallet[] }> => {
						const url = bapId
							? `/wallet/connect?bapId=${encodeURIComponent(bapId)}`
							: "/wallet/connect";
						const res = await $fetch<{ wallets: ConnectedWallet[] }>(url, {
							method: "GET",
						});
						if (res.error) {
							throw new Error(
								res.error.message || "Failed to fetch connected wallets",
							);
						}
						return res.data as { wallets: ConnectedWallet[] };
					},

					/**
					 * Connect a wallet via BSV signature (authToken from bitcoin-auth)
					 * @param bapId - The BAP ID to connect the wallet to
					 * @param authToken - bitcoin-auth token (pubkey|bsm|timestamp|/api/wallet/connect|signature)
					 * @param provider - Wallet provider name (default: "yours")
					 */
					connect: async (
						bapId: string,
						authToken: string,
						provider = "yours",
					): Promise<{
						success: boolean;
						walletAddress: string;
						pubkey: string;
						connectedAt: string;
					}> => {
						const res = await $fetch<{
							success: boolean;
							walletAddress: string;
							pubkey: string;
							connectedAt: string;
						}>("/wallet/connect", {
							method: "POST",
							body: {
								bapId,
								authToken,
								provider,
							},
						});
						if (res.error) {
							throw new Error(res.error.message || "Failed to connect wallet");
						}
						return res.data as {
							success: boolean;
							walletAddress: string;
							pubkey: string;
							connectedAt: string;
						};
					},

					/**
					 * Disconnect a wallet
					 * Note: Uses query params as required by the backend API
					 * @param bapId - The BAP ID the wallet is connected to
					 * @param address - The wallet address to disconnect
					 */
					disconnect: async (
						bapId: string,
						address: string,
					): Promise<{ success: boolean; walletAddress: string }> => {
						const res = await $fetch<{
							success: boolean;
							walletAddress: string;
						}>(
							`/wallet/connect?bapId=${encodeURIComponent(bapId)}&address=${encodeURIComponent(address)}`,
							{
								method: "DELETE",
							},
						);
						if (res.error) {
							throw new Error(
								res.error.message || "Failed to disconnect wallet",
							);
						}
						return res.data as { success: boolean; walletAddress: string };
					},

					/**
					 * Set a wallet as primary (for receiving NFTs)
					 * @param bapId - The BAP ID
					 * @param walletAddress - The wallet address to set as primary
					 */
					setPrimary: async (
						bapId: string,
						walletAddress: string,
					): Promise<{ success: boolean; primaryAddress: string }> => {
						const res = await $fetch<{
							success: boolean;
							primaryAddress: string;
						}>("/wallet/set-primary", {
							method: "POST",
							body: {
								bapId,
								walletAddress,
							},
						});
						if (res.error) {
							throw new Error(
								res.error.message || "Failed to set primary wallet",
							);
						}
						return res.data as { success: boolean; primaryAddress: string };
					},
				},
				nft: {
					/**
					 * Get NFTs across all connected wallets
					 * @param refresh - Force refresh from blockchain (default: false)
					 */
					list: async (refresh = false): Promise<NFTListResponse> => {
						const url = refresh ? "/wallet/nfts?refresh=true" : "/wallet/nfts";
						const res = await $fetch<NFTListResponse>(url, {
							method: "GET",
						});
						if (res.error) {
							throw new Error(res.error.message || "Failed to fetch NFTs");
						}
						return res.data as NFTListResponse;
					},

					/**
					 * Verify ownership of a specific NFT origin or collection
					 * @param params - Verification parameters
					 * @param params.origin - Specific NFT origin to check
					 * @param params.collection - Collection identifier to check
					 * @param params.minCount - Minimum number of NFTs required (default: 1)
					 */
					verifyOwnership: async (params: {
						origin?: string;
						collection?: string;
						minCount?: number;
					}): Promise<NFTOwnershipResponse> => {
						const res = await $fetch<NFTOwnershipResponse>(
							"/wallet/verify-ownership",
							{
								method: "POST",
								body: params,
							},
						);
						if (res.error) {
							throw new Error(
								res.error.message || "Failed to verify NFT ownership",
							);
						}
						return res.data as NFTOwnershipResponse;
					},
				},
				signIn: {
					sigma: async (
						signInOptions?: SigmaSignInOptions,
						fetchOptions?: BetterFetchOption,
					) => {
						// Two modes:
						// 1. With authToken: Call local endpoint (for auth server login)
						// 2. Without authToken: OAuth redirect (for external clients)
						if (signInOptions?.authToken) {
							// Auth server local sign-in - call endpoint with authToken in header
							// IMPORTANT: Spread fetchOptions FIRST so our explicit values override
							const res = await $fetch("/sign-in/sigma", {
								...fetchOptions,
								method: "POST",
								body: {}, // Explicit empty body - authToken goes in header, not body
								headers: {
									...(fetchOptions?.headers as Record<string, string>),
									"X-Auth-Token": signInOptions.authToken,
								},
							});
							return res;
						}

						// Check if already signed in (skip OAuth redirect if session exists)
						// Use $store.session if available from Better Auth client
						// Note: session atom exists at runtime but isn't explicitly typed in ClientStore
						if ($store && !signInOptions?.forceLogin) {
							const sessionAtom = (
								$store as { session?: { get: () => unknown } }
							).session;
							if (sessionAtom) {
								const currentSession = sessionAtom.get();
								if (currentSession) {
									// Already signed in, return existing session
									return { data: currentSession, error: null };
								}
							}
						}

						// External OAuth client - redirect to auth server
						// Validate required clientId for OAuth flow
						if (!signInOptions?.clientId) {
							throw new Error(
								"[Sigma Auth] clientId is required for OAuth flow. " +
									"Pass clientId in signIn.sigma({ clientId: 'your-app', ... }) or set NEXT_PUBLIC_SIGMA_CLIENT_ID environment variable.",
							);
						}

						const state = Math.random().toString(36).substring(7);

						// Generate PKCE parameters for public clients
						const codeVerifier = generateCodeVerifier();
						const codeChallenge = await generateCodeChallenge(codeVerifier);

						if (typeof window !== "undefined") {
							sessionStorage.setItem("sigma_oauth_state", state);
							sessionStorage.setItem("sigma_code_verifier", codeVerifier);
							// Store error callback URL for error handling
							if (signInOptions?.errorCallbackURL) {
								sessionStorage.setItem(
									"sigma_error_callback",
									signInOptions.errorCallbackURL,
								);
							} else {
								sessionStorage.removeItem("sigma_error_callback");
							}
						}

						// IMPORTANT: OAuth authorization MUST go to Sigma auth server, not client's baseURL
						// getBaseURL() returns the client app's URL (e.g., bopen.ai) which is wrong
						// getSigmaUrl() returns the actual auth server (auth.sigmaidentity.com)
						const authUrl = getSigmaUrl();

						// Ensure redirect_uri is always absolute (OAuth requires absolute URLs)
						const origin =
							typeof window !== "undefined" ? window.location.origin : "";
						const callbackPath =
							signInOptions?.callbackURL || "/auth/sigma/callback";
						const redirectUri = callbackPath.startsWith("http")
							? callbackPath
							: `${origin}${callbackPath.startsWith("/") ? callbackPath : `/${callbackPath}`}`;

						const params = new URLSearchParams({
							client_id: signInOptions.clientId,
							redirect_uri: redirectUri,
							response_type: "code",
							state,
							scope: "openid profile",
							code_challenge: codeChallenge,
							code_challenge_method: "S256",
						});

						if (signInOptions?.provider) {
							params.append("provider", signInOptions.provider);
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
						// IMPORTANT: Use $fetch (Better Auth's fetch wrapper) for proper credential/cookie handling
						try {
							const res = await $fetch<OAuthCallbackResult>("/sigma/callback", {
								method: "POST",
								body: {
									code,
									state,
									code_verifier: codeVerifier,
								},
							});

							if (res.error) {
								let errorMessage =
									"Failed to exchange authorization code for access token.";
								let errorTitle = "Token Exchange Failed";

								const errorData = res.error as {
									endpoint?: string;
									status?: number;
									details?: string;
									error?: string;
								};
								const endpoint = errorData.endpoint || "unknown";
								const status = errorData.status || 500;

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

								throw {
									title: errorTitle,
									message: errorMessage,
								} as OAuthCallbackError;
							}

							const data = res.data as OAuthCallbackResult;

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
					 * Encrypt data for a specific friend using Type42 key derivation
					 * Keys stay in Sigma's domain - only encrypted data is returned
					 *
					 * @param data - The plaintext data to encrypt
					 * @param friendBapId - The friend's BAP ID (used as seed for key derivation)
					 * @param theirPublicKey - Optional: the friend's public key for encryption
					 * @returns Promise resolving to base64-encoded encrypted data
					 * @throws Error if no identity set or encryption fails
					 *
					 * @example
					 * ```typescript
					 * const encrypted = await authClient.sigma.encrypt(
					 *   "Hello friend!",
					 *   "friendBapId123",
					 *   friend.themPublicKey
					 * );
					 * ```
					 */
					encrypt: async (
						data: string,
						friendBapId: string,
						theirPublicKey?: string,
					): Promise<string> => {
						const bapId = storedBapId || loadStoredBapId();
						if (!bapId) {
							throw new Error(
								"No identity set. Complete OAuth login first or call setIdentity().",
							);
						}

						const signerInstance = await getOrCreateSigner();
						signerInstance.setIdentity(bapId);

						return signerInstance.encrypt(data, friendBapId, theirPublicKey);
					},

					/**
					 * Decrypt data from a specific friend using Type42 key derivation
					 * Keys stay in Sigma's domain - only decrypted data is returned
					 *
					 * @param ciphertext - The base64-encoded encrypted data
					 * @param friendBapId - The friend's BAP ID (used as seed for key derivation)
					 * @param theirPublicKey - Optional: the sender's public key for decryption
					 * @returns Promise resolving to decrypted plaintext
					 * @throws Error if no identity set or decryption fails
					 *
					 * @example
					 * ```typescript
					 * const decrypted = await authClient.sigma.decrypt(
					 *   encryptedContent,
					 *   "friendBapId123",
					 *   friend.themPublicKey
					 * );
					 * ```
					 */
					decrypt: async (
						ciphertext: string,
						friendBapId: string,
						theirPublicKey?: string,
					): Promise<string> => {
						const bapId = storedBapId || loadStoredBapId();
						if (!bapId) {
							throw new Error(
								"No identity set. Complete OAuth login first or call setIdentity().",
							);
						}

						const signerInstance = await getOrCreateSigner();
						signerInstance.setIdentity(bapId);

						return signerInstance.decrypt(
							ciphertext,
							friendBapId,
							theirPublicKey,
						);
					},

					/**
					 * Get the derived public key for a specific friend
					 * Used in friend requests and for encryption key exchange
					 *
					 * @param friendBapId - The friend's BAP ID (used as seed for key derivation)
					 * @returns Promise resolving to hex-encoded public key
					 * @throws Error if no identity set or derivation fails
					 *
					 * @example
					 * ```typescript
					 * // Get public key to include in friend request transaction
					 * const myPubKeyForFriend = await authClient.sigma.getFriendPublicKey(friendBapId);
					 * ```
					 */
					getFriendPublicKey: async (friendBapId: string): Promise<string> => {
						const bapId = storedBapId || loadStoredBapId();
						if (!bapId) {
							throw new Error(
								"No identity set. Complete OAuth login first or call setIdentity().",
							);
						}

						const signerInstance = await getOrCreateSigner();
						signerInstance.setIdentity(bapId);

						return signerInstance.getFriendPublicKey(friendBapId);
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
							signerType = null;
						}
					},

					/**
					 * Detect which server to use (local vs cloud)
					 * Call this to explicitly probe for local server
					 * @returns Promise resolving to { url: string, isLocal: boolean }
					 */
					detectServer: async (): Promise<{
						url: string;
						isLocal: boolean;
					}> => {
						const localSigner = new LocalServerSigner({
							baseUrl: localServerOptions.baseUrl || getLocalServerUrl(),
							timeout: localServerOptions.timeout,
						});

						if (await localSigner.probe()) {
							return { url: localSigner.getBaseUrl(), isLocal: true };
						}
						return { url: getSigmaUrl(), isLocal: false };
					},

					/**
					 * Get the current signer type being used
					 * @returns 'local' | 'iframe' | null
					 */
					getSignerType: (): "local" | "iframe" | null => {
						return signerType;
					},

					/**
					 * Get the underlying signer instance
					 * Useful for advanced usage
					 */
					getSigner: async (): Promise<SigmaSigner> => {
						return getOrCreateSigner();
					},

					/**
					 * Check if the signer is ready for signing
					 * @returns true if identity is set and signer is initialized
					 */
					isReady: (): boolean => {
						const bapId = storedBapId || loadStoredBapId();
						return !!bapId;
					},

					/**
					 * Get the stored error callback URL
					 * @returns The error callback URL or default /auth/sigma/error
					 */
					getErrorCallbackURL: (): string => {
						if (typeof window === "undefined") return "/auth/sigma/error";
						return (
							sessionStorage.getItem("sigma_error_callback") ||
							"/auth/sigma/error"
						);
					},

					/**
					 * Redirect to error callback with error details
					 * Use this in your callback page's catch block
					 *
					 * @param error - The error object from handleCallback
					 *
					 * @example
					 * ```typescript
					 * try {
					 *   const result = await authClient.sigma.handleCallback(searchParams);
					 * } catch (err) {
					 *   authClient.sigma.redirectToError(err);
					 * }
					 * ```
					 */
					redirectToError: (error: unknown): void => {
						if (typeof window === "undefined") return;

						const errorCallbackURL =
							sessionStorage.getItem("sigma_error_callback") ||
							"/auth/sigma/error";

						// Clean up session storage
						sessionStorage.removeItem("sigma_error_callback");
						sessionStorage.removeItem("sigma_oauth_state");
						sessionStorage.removeItem("sigma_code_verifier");

						// Build error URL with query params
						const errorUrl = new URL(errorCallbackURL, window.location.origin);

						if (
							error &&
							typeof error === "object" &&
							"title" in error &&
							"message" in error
						) {
							const oauthError = error as OAuthCallbackError;
							errorUrl.searchParams.set("error", oauthError.title);
							errorUrl.searchParams.set(
								"error_description",
								oauthError.message,
							);
						} else if (error instanceof Error) {
							errorUrl.searchParams.set("error", "callback_error");
							errorUrl.searchParams.set("error_description", error.message);
						} else {
							errorUrl.searchParams.set("error", "unknown_error");
							errorUrl.searchParams.set(
								"error_description",
								"An unknown error occurred",
							);
						}

						window.location.href = errorUrl.toString();
					},
				},
			};
		},
	} satisfies BetterAuthClientPlugin;
};
