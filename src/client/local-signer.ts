/**
 * Local Server Signer
 *
 * Provides signing and encryption via HTTP calls to a local TokenPass server.
 * This is an alternative to SigmaIframeSigner for users who run TokenPass locally.
 *
 * Features:
 * - Probes for local server availability
 * - Authenticates with the local server to get access tokens
 * - Signs requests using bitcoin-auth format
 * - Supports AIP signing for OP_RETURN data
 * - Supports Type42 encryption/decryption
 */

/**
 * Interface for the Sigma signer implementations
 */
export interface SigmaSigner {
	sign(
		path: string,
		body?: string,
		signatureType?: "bsm" | "brc77",
	): Promise<string>;
	signAIP(hexArray: string[]): Promise<string[]>;
	encrypt(
		data: string,
		friendBapId: string,
		theirPublicKey?: string,
	): Promise<string>;
	decrypt(
		ciphertext: string,
		friendBapId: string,
		theirPublicKey?: string,
	): Promise<string>;
	getFriendPublicKey(friendBapId: string): Promise<string>;
	isReady(): boolean;
	setIdentity(bapId: string): void;
	getIdentity(): string | null;
	destroy(): void;
}

export interface LocalServerSignerOptions {
	/** Base URL of the local TokenPass server (default: http://localhost:21000) */
	baseUrl?: string;
	/** Request timeout in milliseconds (default: 5000) */
	timeout?: number;
}

export interface LocalServerStatus {
	created: boolean;
	unlocked: boolean;
	bapId?: string;
	address?: string;
}

/**
 * LocalServerSigner - HTTP-based signer for local TokenPass server
 *
 * This signer communicates with a locally-running TokenPass server
 * via HTTP instead of using an iframe. This provides a better UX for
 * users who prefer to run their own identity server.
 */
export class LocalServerSigner implements SigmaSigner {
	private baseUrl: string;
	private timeout: number;
	private accessToken: string | null = null;
	private currentBapId: string | null = null;

	constructor(options: LocalServerSignerOptions = {}) {
		this.baseUrl = options.baseUrl || "http://localhost:21000";
		this.timeout = options.timeout || 5000;
	}

	/**
	 * Check if the local TokenPass server is running and accessible
	 */
	async probe(): Promise<boolean> {
		try {
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), 500);

			const res = await fetch(`${this.baseUrl}/api/status`, {
				signal: controller.signal,
			});

			clearTimeout(timeoutId);
			return res.ok;
		} catch {
			return false;
		}
	}

	/**
	 * Get the status of the local TokenPass server
	 */
	async getStatus(): Promise<LocalServerStatus | null> {
		try {
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), this.timeout);

			const res = await fetch(`${this.baseUrl}/api/status`, {
				signal: controller.signal,
			});

			clearTimeout(timeoutId);

			if (!res.ok) return null;

			return (await res.json()) as LocalServerStatus;
		} catch {
			return null;
		}
	}

	/**
	 * Authenticate with the local server to get an access token
	 */
	async authenticate(
		host: string,
		scopes: string[] = ["sign", "encrypt", "decrypt"],
		expiry = "1h",
	): Promise<boolean> {
		try {
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), this.timeout);

			const res = await fetch(`${this.baseUrl}/api/auth`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ host, scopes, expiry }),
				signal: controller.signal,
			});

			clearTimeout(timeoutId);

			if (!res.ok) return false;

			const data = (await res.json()) as { accessToken: string };
			this.accessToken = data.accessToken;
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Check if the signer is ready (has an access token)
	 */
	isReady(): boolean {
		return this.accessToken !== null;
	}

	/**
	 * Set the identity (BAP ID) for signing
	 */
	setIdentity(bapId: string): void {
		this.currentBapId = bapId;
	}

	/**
	 * Get the current identity
	 */
	getIdentity(): string | null {
		return this.currentBapId;
	}

	/**
	 * Sign a request using the local TokenPass server
	 * Returns a bitcoin-auth format token: pubkey|scheme|timestamp|path|signature
	 */
	async sign(
		path: string,
		body?: string,
		signatureType: "bsm" | "brc77" = "brc77",
	): Promise<string> {
		if (!this.accessToken) {
			throw new Error("Not authenticated. Call authenticate() first.");
		}

		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), this.timeout);

		try {
			const res = await fetch(`${this.baseUrl}/api/sign`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${this.accessToken}`,
				},
				body: JSON.stringify({
					path,
					body,
					signatureType,
				}),
				signal: controller.signal,
			});

			clearTimeout(timeoutId);

			if (!res.ok) {
				const error = await res.text();
				throw new Error(`Sign request failed: ${error}`);
			}

			const data = (await res.json()) as { token: string };
			return data.token;
		} catch (err) {
			clearTimeout(timeoutId);
			throw err;
		}
	}

	/**
	 * Sign OP_RETURN data with AIP for Bitcoin transactions
	 */
	async signAIP(hexArray: string[]): Promise<string[]> {
		if (!this.accessToken) {
			throw new Error("Not authenticated. Call authenticate() first.");
		}

		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), this.timeout);

		try {
			const res = await fetch(`${this.baseUrl}/api/sign-aip`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${this.accessToken}`,
				},
				body: JSON.stringify({ data: hexArray }),
				signal: controller.signal,
			});

			clearTimeout(timeoutId);

			if (!res.ok) {
				const error = await res.text();
				throw new Error(`AIP sign request failed: ${error}`);
			}

			const data = (await res.json()) as { signedOps: string[] };
			return data.signedOps;
		} catch (err) {
			clearTimeout(timeoutId);
			throw err;
		}
	}

	/**
	 * Encrypt data for a specific friend using Type42 key derivation
	 */
	async encrypt(
		data: string,
		friendBapId: string,
		theirPublicKey?: string,
	): Promise<string> {
		if (!this.accessToken) {
			throw new Error("Not authenticated. Call authenticate() first.");
		}

		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), this.timeout);

		try {
			const res = await fetch(`${this.baseUrl}/api/encrypt`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${this.accessToken}`,
				},
				body: JSON.stringify({
					data,
					friendBapId,
					theirPublicKey,
				}),
				signal: controller.signal,
			});

			clearTimeout(timeoutId);

			if (!res.ok) {
				const error = await res.text();
				throw new Error(`Encrypt request failed: ${error}`);
			}

			const result = (await res.json()) as { ciphertext: string };
			return result.ciphertext;
		} catch (err) {
			clearTimeout(timeoutId);
			throw err;
		}
	}

	/**
	 * Decrypt data from a specific friend using Type42 key derivation
	 */
	async decrypt(
		ciphertext: string,
		friendBapId: string,
		theirPublicKey?: string,
	): Promise<string> {
		if (!this.accessToken) {
			throw new Error("Not authenticated. Call authenticate() first.");
		}

		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), this.timeout);

		try {
			const res = await fetch(`${this.baseUrl}/api/decrypt`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${this.accessToken}`,
				},
				body: JSON.stringify({
					ciphertext,
					friendBapId,
					theirPublicKey,
				}),
				signal: controller.signal,
			});

			clearTimeout(timeoutId);

			if (!res.ok) {
				const error = await res.text();
				throw new Error(`Decrypt request failed: ${error}`);
			}

			const result = (await res.json()) as { data: string };
			return result.data;
		} catch (err) {
			clearTimeout(timeoutId);
			throw err;
		}
	}

	/**
	 * Get the derived public key for a specific friend
	 */
	async getFriendPublicKey(friendBapId: string): Promise<string> {
		if (!this.accessToken) {
			throw new Error("Not authenticated. Call authenticate() first.");
		}

		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), this.timeout);

		try {
			const res = await fetch(`${this.baseUrl}/api/friend-pubkey`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${this.accessToken}`,
				},
				body: JSON.stringify({ friendBapId }),
				signal: controller.signal,
			});

			clearTimeout(timeoutId);

			if (!res.ok) {
				const error = await res.text();
				throw new Error(`Get friend public key failed: ${error}`);
			}

			const result = (await res.json()) as { publicKey: string };
			return result.publicKey;
		} catch (err) {
			clearTimeout(timeoutId);
			throw err;
		}
	}

	/**
	 * Get the base URL of this signer
	 */
	getBaseUrl(): string {
		return this.baseUrl;
	}

	/**
	 * Cleanup - nothing to do for HTTP client
	 */
	destroy(): void {
		this.accessToken = null;
		this.currentBapId = null;
	}
}
