import type { BetterAuthPlugin, User } from "better-auth";
import type { BAPProfile } from "../types/index.js";

/**
 * NFT collection configuration for role assignment
 */
export interface NFTCollection {
	/** Collection ID (txid_vout format) */
	id: string;
	/** Role to assign when user owns NFTs from this collection */
	role: string;
}

/**
 * Token balance gate configuration for role assignment
 */
export interface TokenGate {
	/** Token ticker (e.g., "GM", "LOL") or BSV21 ID */
	ticker: string;
	/** Minimum balance required */
	threshold: number;
	/** Role to assign when threshold is met */
	role: string;
}

/**
 * Extended roles callback type
 * Allows apps to add custom role resolution logic
 *
 * @param user - Better Auth user object
 * @param bap - Bitcoin Attestation Protocol identity
 * @param address - Primary Bitcoin address
 * @returns Array of additional role names to assign
 */
export type ExtendRolesCallback = (
	user: User,
	bap: BAPProfile | null,
	address: string | null,
) => Promise<string[]>;

/**
 * Configuration options for the Sigma Admin plugin
 */
export interface SigmaAdminOptions {
	/**
	 * NFT collections for role assignment
	 * Users owning NFTs from these collections will receive the specified roles
	 *
	 * @example
	 * ```typescript
	 * nftCollections: [
	 *   { id: "abc123_0", role: "pixel-fox-holder" },
	 *   { id: "def456_0", role: "premium" },
	 * ]
	 * ```
	 */
	nftCollections?: NFTCollection[];

	/**
	 * Token balance gates for role assignment
	 * Users meeting token balance thresholds will receive the specified roles
	 *
	 * @example
	 * ```typescript
	 * tokenGates: [
	 *   { ticker: "GM", threshold: 75000, role: "premium" },
	 *   { ticker: "GM", threshold: 1000000, role: "whale" },
	 * ]
	 * ```
	 */
	tokenGates?: TokenGate[];

	/**
	 * Admin BAP IDs whitelist
	 * Users with these BAP IDs will receive the "admin" role
	 */
	adminBAPIds?: string[];

	/**
	 * Custom role resolution callback
	 * Extend roles with app-specific logic (e.g., Discord trust system, database lookups)
	 *
	 * @example
	 * ```typescript
	 * extendRoles: async (user, bap, address) => {
	 *   const roles = [];
	 *
	 *   // Map Bitcoin address to Discord user
	 *   const discordUserId = await getDiscordUserByAddress(address);
	 *   if (discordUserId) {
	 *     if (await isKingmaker(discordUserId)) {
	 *       roles.push("kingmaker");
	 *     }
	 *   }
	 *
	 *   return roles;
	 * }
	 * ```
	 */
	extendRoles?: ExtendRolesCallback;

	/**
	 * Get connected wallet addresses for a user's BAP profile
	 * Required for NFT/token checking
	 *
	 * @param userId - Better Auth user ID
	 * @returns Array of Bitcoin addresses from connected wallets
	 */
	getWalletAddresses?: (userId: string) => Promise<string[]>;

	/**
	 * NFT ownership checker function
	 * Required if using nftCollections
	 *
	 * @param address - Bitcoin address to check
	 * @param collectionId - NFT collection ID (txid_vout)
	 * @returns True if address owns at least one NFT from the collection
	 */
	checkNFTOwnership?: (
		address: string,
		collectionId: string,
	) => Promise<boolean>;

	/**
	 * Token balance checker function
	 * Required if using tokenGates
	 *
	 * @param address - Bitcoin address to check
	 * @param ticker - Token ticker or ID
	 * @returns Token balance as number
	 */
	getTokenBalance?: (address: string, ticker: string) => Promise<number>;

	/**
	 * BAP profile resolver function
	 * Fetches BAP identity data for a user
	 *
	 * @param userId - Better Auth user ID
	 * @returns BAP profile or null
	 */
	getBAPProfile?: (userId: string) => Promise<BAPProfile | null>;
}

/**
 * Sigma Admin Plugin for Better Auth
 * Provides Bitcoin-native role resolution based on NFT ownership, token balances, and custom logic
 *
 * @example
 * ```typescript
 * import { betterAuth } from "better-auth";
 * import { admin } from "better-auth/plugins";
 * import { sigmaAdminPlugin } from "@sigma-auth/better-auth-plugin/server";
 *
 * export const auth = betterAuth({
 *   plugins: [
 *     sigmaAdminPlugin({
 *       nftCollections: [
 *         { id: PIXEL_FOX_COLLECTION_ID, role: "pixel-fox-holder" },
 *       ],
 *       tokenGates: [
 *         { ticker: "GM", threshold: 75000, role: "premium" },
 *       ],
 *       adminBAPIds: [process.env.SUPERADMIN_BAP_ID],
 *       extendRoles: async (user, bap, address) => {
 *         // Custom role resolution
 *         return [];
 *       },
 *       checkNFTOwnership: async (address, collectionId) => {
 *         const nfts = await fetchNftUtxos(address, collectionId);
 *         return nfts.length > 0;
 *       },
 *       getTokenBalance: async (address, ticker) => {
 *         const balance = await fetchTokenBalance(address, ticker);
 *         return Number(balance);
 *       },
 *     }),
 *     admin({
 *       defaultRole: "user",
 *     }),
 *   ],
 * });
 * ```
 */
export const sigmaAdminPlugin = (
	options: SigmaAdminOptions = {},
): BetterAuthPlugin => {
	return {
		id: "sigma-admin",

		schema: {
			user: {
				fields: {
					roles: {
						type: "string",
						required: false,
						defaultValue: "user",
					},
				},
			},
			session: {
				fields: {
					roles: {
						type: "string",
						required: false,
					},
				},
			},
		},

		hooks: {
			after: [
				{
					// After session creation, resolve and attach roles
					matcher: (ctx) =>
						ctx.path === "/sign-in/sigma" ||
						ctx.path === "/session" ||
						ctx.path === "/get-session",
					handler: async (ctx) => {
						// Cast to access internal context properties
						const context = (
							ctx as unknown as {
								context: {
									session?: { user?: User };
									returned?: unknown;
								};
							}
						).context;
						const session = context?.session;
						if (!session?.user?.id) {
							return;
						}

						try {
							// Resolve roles for this user
							const roles = await resolveUserRoles(session.user, options);

							// Update session with roles
							const rolesString = roles.join(",");

							// Update the session in the response
							if (context.returned && typeof context.returned === "object") {
								const returned = context.returned as {
									session?: { user?: { roles?: string } };
									user?: { roles?: string };
								};

								if (returned.session?.user) {
									returned.session.user.roles = rolesString;
								}
								if (returned.user) {
									returned.user.roles = rolesString;
								}
							}
						} catch (error) {
							console.error("[Sigma Admin] Error resolving roles:", error);
							// Don't block session on role resolution failure
						}
					},
				},
			],
		},
	};
};

/**
 * Resolve all roles for a user based on configuration
 * @internal
 */
async function resolveUserRoles(
	user: User,
	options: SigmaAdminOptions,
): Promise<string[]> {
	const roles: string[] = ["user"];

	try {
		// Include static database role from Better Auth admin plugin
		// This allows manual admin assignment via setRole() to work alongside
		// dynamic role resolution (BAP IDs, NFTs, tokens)
		const userWithRole = user as User & { role?: string };
		if (userWithRole.role && userWithRole.role !== "user") {
			// Role can be a single role or comma-separated list
			const staticRoles = userWithRole.role.split(",").map((r) => r.trim());
			for (const role of staticRoles) {
				if (role && !roles.includes(role)) {
					roles.push(role);
				}
			}
		}

		// Get BAP profile if resolver provided
		let bap: BAPProfile | null = null;
		if (options.getBAPProfile) {
			bap = await options.getBAPProfile(user.id);
		}

		// Check admin BAP IDs (dynamic admin based on BAP identity)
		if (bap?.idKey && options.adminBAPIds?.includes(bap.idKey)) {
			if (!roles.includes("admin")) {
				roles.push("admin");
			}
		}

		// Get connected wallet addresses
		const walletAddresses: string[] = [];
		if (options.getWalletAddresses) {
			const addresses = await options.getWalletAddresses(user.id);
			walletAddresses.push(...addresses);
		}

		// Check NFT ownership across all connected wallets
		if (
			walletAddresses.length > 0 &&
			options.nftCollections &&
			options.nftCollections.length > 0 &&
			options.checkNFTOwnership
		) {
			for (const collection of options.nftCollections) {
				// Check if ANY wallet owns NFTs from this collection
				let ownsNFT = false;
				for (const address of walletAddresses) {
					if (await options.checkNFTOwnership(address, collection.id)) {
						ownsNFT = true;
						break;
					}
				}
				if (ownsNFT && !roles.includes(collection.role)) {
					roles.push(collection.role);
				}
			}
		}

		// Check token balances across all connected wallets
		if (
			walletAddresses.length > 0 &&
			options.tokenGates &&
			options.tokenGates.length > 0 &&
			options.getTokenBalance
		) {
			for (const gate of options.tokenGates) {
				// Sum balances across all wallets
				let totalBalance = 0;
				for (const address of walletAddresses) {
					const balance = await options.getTokenBalance(address, gate.ticker);
					totalBalance += balance;
				}
				if (totalBalance >= gate.threshold && !roles.includes(gate.role)) {
					roles.push(gate.role);
				}
			}
		}

		// Extend with custom roles
		if (options.extendRoles) {
			// Pass first wallet address for backward compatibility
			const primaryAddress = walletAddresses[0] || null;
			const customRoles = await options.extendRoles(user, bap, primaryAddress);
			for (const role of customRoles) {
				if (!roles.includes(role)) {
					roles.push(role);
				}
			}
		}
	} catch (error) {
		console.error("[Sigma Admin] Error in role resolution:", error);
		// Return base "user" role on error
	}

	return roles;
}
