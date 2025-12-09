import type { User } from "better-auth";

/**
 * BAP Profile structure from api.sigmaidentity.com
 * Stored in profile.profile JSONB column
 */
export interface BAPProfile {
	idKey: string; // BAP identity key (e.g. "A4PYmuKGG61WCjjBaRpuSEbqytG")
	rootAddress: string; // Root Bitcoin address
	currentAddress?: string; // Current Bitcoin address
	addresses?: Array<{ address: string; txId: string; block: number }>; // Historical addresses
	identity?: {
		"@context"?: string; // Schema.org context
		"@type"?: string; // Schema.org type (e.g. "Person")
		alternateName?: string; // Display name/username
		givenName?: string; // First name
		familyName?: string; // Last name
		image?: string; // Profile image URL
		banner?: string; // Banner image URL
		description?: string; // Bio/description
		[key: string]: unknown; // Additional schema.org fields
	};
	[key: string]: unknown; // Additional BAP fields
}

/**
 * OIDC userinfo response with Sigma Identity extensions
 * Extends Better Auth's User type with BAP-specific fields
 *
 * Standard OIDC claims:
 * - sub, name, given_name, family_name, picture
 *
 * Custom claims:
 * - pubkey: Bitcoin public key for this identity
 * - bap: Full BAP identity from api.sigmaidentity.com/blockchain
 */
export interface SigmaUserInfo extends Omit<User, "id"> {
	// OIDC standard claims
	sub: string; // User ID (maps to User.id)
	given_name?: string; // From bap.identity.givenName
	family_name?: string | null; // From bap.identity.familyName
	picture?: string | null; // From bap.identity.image

	// Custom claims
	pubkey: string; // Bitcoin public key
	bap_id?: string; // BAP identity ID for signing (direct claim)
	bap?: BAPProfile | string | null; // Full BAP identity data (may be JSON string from JWT)
}

/**
 * Subscription tier levels
 */
export type SubscriptionTier =
	| "free"
	| "plus"
	| "pro"
	| "premium"
	| "enterprise";

/**
 * Subscription status from auth server
 */
export interface SubscriptionStatus {
	tier: SubscriptionTier;
	isActive: boolean;
	nftOrigin?: string;
	walletAddress?: string;
	expiresAt?: Date;
	validUntil?: string;
	lastVerified?: string;
	features?: string[];
}

/**
 * Connected wallet information from sigma-auth
 * Note: Field names match the actual API response
 */
export interface ConnectedWallet {
	address: string;
	provider: string;
	connectionMethod: string;
	recovery_params?: Record<string, unknown>;
	isPrimary: boolean;
	connectedAt: string;
	lastVerified: string;
}

/**
 * NFT response grouped by wallet address
 */
export interface WalletNFTs {
	address: string;
	nfts: NFT[];
	count: number;
	error?: string;
}

/**
 * Response from /api/wallet/nfts
 */
export interface NFTListResponse {
	wallets: WalletNFTs[];
	totalNFTs: number;
	addresses: string[];
}

/**
 * Response from /api/wallet/verify-ownership
 */
export interface NFTOwnershipResponse {
	owns: boolean;
	count: number;
	nfts?: NFT[];
	message?: string;
}

/**
 * NFT origin data from Gorilla Pool
 */
export interface NFTOrigin {
	outpoint: string;
	data?: {
		insc?: {
			file: {
				hash: string;
				size: number;
				type: string;
			};
		};
		map?: Record<string, unknown>;
	};
}

/**
 * NFT from connected wallets (via Gorilla Pool API)
 */
export interface NFT {
	txid: string;
	vout: number;
	outpoint: string;
	satoshis: number;
	owner: string;
	origin?: NFTOrigin;
	height?: number;
	idx?: number;
}

/**
 * OAuth provider types supported by Sigma Auth
 */
export type OAuthProvider = "github" | "apple" | "twitter";

/**
 * OAuth callback result returned after successful authentication
 */
export interface OAuthCallbackResult {
	user: SigmaUserInfo;
	access_token: string;
	id_token: string;
	refresh_token?: string;
}

/**
 * OAuth callback error structure
 */
export interface OAuthCallbackError {
	title: string;
	message: string;
}
