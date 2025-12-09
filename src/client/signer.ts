/**
 * Sigma Iframe Signer
 *
 * Provides seamless client-side signing and encryption via embedded Sigma iframe.
 * Keys stay in auth.sigmaidentity.com - never exposed to client apps.
 *
 * Protocol:
 * - Parent → Iframe: SET_IDENTITY, SIGN_REQUEST, SIGN_AIP_REQUEST,
 *                    ENCRYPT_REQUEST, DECRYPT_REQUEST, GET_FRIEND_PUBKEY_REQUEST
 * - Iframe → Parent: WALLET_LOCKED, WALLET_UNLOCKED, SIGN_RESPONSE, SIGN_AIP_RESPONSE,
 *                    ENCRYPT_RESPONSE, DECRYPT_RESPONSE, GET_FRIEND_PUBKEY_RESPONSE, SIGNER_ERROR
 */

interface SignatureRequest {
	requestId: string;
	requestPath: string;
	body?: string;
	signatureType?: "bsm" | "brc77";
	bodyEncoding?: "utf8" | "hex" | "base64";
}

interface SignatureResponse {
	requestId: string;
	authToken: string;
	signingPubkey?: string;
	error?: string;
}

interface AIPSignRequest {
	requestId: string;
	hexArray: string[];
}

interface AIPSignResponse {
	requestId: string;
	signedOps?: string[];
	error?: string;
}

interface EncryptRequest {
	requestId: string;
	data: string;
	friendBapId: string;
	counterPartyPublicKey?: string;
}

interface EncryptResponse {
	requestId: string;
	encrypted?: string;
	error?: string;
}

interface DecryptRequest {
	requestId: string;
	ciphertext: string;
	friendBapId: string;
	counterPartyPublicKey?: string;
}

interface DecryptResponse {
	requestId: string;
	decrypted?: string;
	error?: string;
}

interface GetFriendPubkeyRequest {
	requestId: string;
	friendBapId: string;
}

interface GetFriendPubkeyResponse {
	requestId: string;
	publicKey?: string;
	error?: string;
}

interface PendingRequest<T> {
	resolve: (value: T) => void;
	reject: (error: Error) => void;
	timeout: ReturnType<typeof setTimeout>;
}

export class SigmaIframeSigner {
	private iframe: HTMLIFrameElement | null = null;
	private pendingRequests: Map<string, PendingRequest<string>> = new Map();
	private pendingAIPRequests: Map<string, PendingRequest<string[]>> = new Map();
	private pendingEncryptRequests: Map<string, PendingRequest<string>> =
		new Map();
	private pendingDecryptRequests: Map<string, PendingRequest<string>> =
		new Map();
	private pendingGetFriendPubkeyRequests: Map<string, PendingRequest<string>> =
		new Map();
	private initialized = false;
	private boundMessageHandler: ((event: MessageEvent) => void) | null = null;
	private currentBapId: string | null = null;
	private sigmaUrl: string;

	constructor(sigmaUrl: string) {
		this.sigmaUrl = sigmaUrl;
	}

	/**
	 * Initialize the Sigma signer iframe (lazy - called on first sign request)
	 */
	async init(): Promise<void> {
		if (typeof window === "undefined") {
			throw new Error("SigmaIframeSigner can only be used in browser");
		}

		if (this.initialized) return;

		// Create hidden iframe for Sigma signer
		this.iframe = document.createElement("iframe");
		this.iframe.src = `${this.sigmaUrl}/signer`;
		this.iframe.style.cssText = `
			position: fixed;
			inset: 0;
			width: 100vw;
			height: 100vh;
			border: none;
			background: transparent;
			z-index: 10000;
			display: none;
			pointer-events: auto;
		`;
		document.body.appendChild(this.iframe);

		// Set up message listener
		this.boundMessageHandler = this.handleMessage.bind(this);
		window.addEventListener("message", this.boundMessageHandler);

		// Wait for iframe to load
		const iframe = this.iframe;
		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(
				() => reject(new Error("Sigma iframe load timeout")),
				10000,
			);
			iframe.addEventListener("load", () => {
				clearTimeout(timeout);
				this.initialized = true;
				resolve();
			});
			iframe.addEventListener("error", () => {
				clearTimeout(timeout);
				reject(new Error("Failed to load Sigma iframe"));
			});
		});
	}

	/**
	 * Set the identity for signing
	 */
	setIdentity(bapId: string): void {
		this.currentBapId = bapId;

		if (this.initialized && this.iframe?.contentWindow) {
			this.iframe.contentWindow.postMessage(
				{ type: "SET_IDENTITY", payload: { bapId } },
				this.sigmaUrl,
			);
		}
	}

	/**
	 * Sign a request
	 */
	async sign(
		requestPath: string,
		body?: string,
		signatureType: "bsm" | "brc77" = "brc77",
	): Promise<string> {
		if (!this.initialized) {
			await this.init();
		}

		if (!this.currentBapId) {
			throw new Error("No identity set. Call setIdentity() first.");
		}

		const contentWindow = this.iframe?.contentWindow;
		if (!contentWindow) {
			throw new Error("Sigma iframe not accessible");
		}

		// Ensure identity is set
		contentWindow.postMessage(
			{ type: "SET_IDENTITY", payload: { bapId: this.currentBapId } },
			this.sigmaUrl,
		);

		const requestId = `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

		const request: SignatureRequest = {
			requestId,
			requestPath,
			signatureType,
		};

		if (body) {
			request.body = body;
			request.bodyEncoding = "utf8";
		}

		return new Promise<string>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pendingRequests.delete(requestId);
				reject(new Error("Signature request timeout"));
			}, 30000);

			this.pendingRequests.set(requestId, { resolve, reject, timeout });

			contentWindow.postMessage(
				{ type: "SIGN_REQUEST", payload: request },
				this.sigmaUrl,
			);
		});
	}

	/**
	 * Sign OP_RETURN data with AIP
	 */
	async signAIP(hexArray: string[]): Promise<string[]> {
		if (!this.initialized) {
			await this.init();
		}

		if (!this.currentBapId) {
			throw new Error("No identity set. Call setIdentity() first.");
		}

		const contentWindow = this.iframe?.contentWindow;
		if (!contentWindow) {
			throw new Error("Sigma iframe not accessible");
		}

		// Ensure identity is set
		contentWindow.postMessage(
			{ type: "SET_IDENTITY", payload: { bapId: this.currentBapId } },
			this.sigmaUrl,
		);

		const requestId = `aip_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

		const request: AIPSignRequest = {
			requestId,
			hexArray,
		};

		return new Promise<string[]>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pendingAIPRequests.delete(requestId);
				reject(new Error("AIP signature request timeout"));
			}, 30000);

			this.pendingAIPRequests.set(requestId, { resolve, reject, timeout });

			contentWindow.postMessage(
				{ type: "SIGN_AIP_REQUEST", payload: request },
				this.sigmaUrl,
			);
		});
	}

	/**
	 * Encrypt data for a specific friend using Type42 key derivation
	 * @param data - The plaintext data to encrypt
	 * @param friendBapId - The friend's BAP ID (used as seed for key derivation)
	 * @param counterPartyPublicKey - Optional: the friend's public key for encryption
	 */
	async encrypt(
		data: string,
		friendBapId: string,
		counterPartyPublicKey?: string,
	): Promise<string> {
		if (!this.initialized) {
			await this.init();
		}

		if (!this.currentBapId) {
			throw new Error("No identity set. Call setIdentity() first.");
		}

		const contentWindow = this.iframe?.contentWindow;
		if (!contentWindow) {
			throw new Error("Sigma iframe not accessible");
		}

		// Ensure identity is set
		contentWindow.postMessage(
			{ type: "SET_IDENTITY", payload: { bapId: this.currentBapId } },
			this.sigmaUrl,
		);

		const requestId = `enc_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

		const request: EncryptRequest = {
			requestId,
			data,
			friendBapId,
			counterPartyPublicKey,
		};

		return new Promise<string>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pendingEncryptRequests.delete(requestId);
				reject(new Error("Encryption request timeout"));
			}, 30000);

			this.pendingEncryptRequests.set(requestId, { resolve, reject, timeout });

			contentWindow.postMessage(
				{ type: "ENCRYPT_REQUEST", payload: request },
				this.sigmaUrl,
			);
		});
	}

	/**
	 * Decrypt data from a specific friend using Type42 key derivation
	 * @param ciphertext - The encrypted data (base64 encoded)
	 * @param friendBapId - The friend's BAP ID (used as seed for key derivation)
	 * @param counterPartyPublicKey - Optional: the sender's public key for decryption
	 */
	async decrypt(
		ciphertext: string,
		friendBapId: string,
		counterPartyPublicKey?: string,
	): Promise<string> {
		if (!this.initialized) {
			await this.init();
		}

		if (!this.currentBapId) {
			throw new Error("No identity set. Call setIdentity() first.");
		}

		const contentWindow = this.iframe?.contentWindow;
		if (!contentWindow) {
			throw new Error("Sigma iframe not accessible");
		}

		// Ensure identity is set
		contentWindow.postMessage(
			{ type: "SET_IDENTITY", payload: { bapId: this.currentBapId } },
			this.sigmaUrl,
		);

		const requestId = `dec_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

		const request: DecryptRequest = {
			requestId,
			ciphertext,
			friendBapId,
			counterPartyPublicKey,
		};

		return new Promise<string>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pendingDecryptRequests.delete(requestId);
				reject(new Error("Decryption request timeout"));
			}, 30000);

			this.pendingDecryptRequests.set(requestId, { resolve, reject, timeout });

			contentWindow.postMessage(
				{ type: "DECRYPT_REQUEST", payload: request },
				this.sigmaUrl,
			);
		});
	}

	/**
	 * Get the derived public key for a specific friend
	 * This key is used in friend requests and for encryption
	 * @param friendBapId - The friend's BAP ID (used as seed for key derivation)
	 */
	async getFriendPublicKey(friendBapId: string): Promise<string> {
		if (!this.initialized) {
			await this.init();
		}

		if (!this.currentBapId) {
			throw new Error("No identity set. Call setIdentity() first.");
		}

		const contentWindow = this.iframe?.contentWindow;
		if (!contentWindow) {
			throw new Error("Sigma iframe not accessible");
		}

		// Ensure identity is set
		contentWindow.postMessage(
			{ type: "SET_IDENTITY", payload: { bapId: this.currentBapId } },
			this.sigmaUrl,
		);

		const requestId = `pubkey_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

		const request: GetFriendPubkeyRequest = {
			requestId,
			friendBapId,
		};

		return new Promise<string>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pendingGetFriendPubkeyRequests.delete(requestId);
				reject(new Error("Get friend public key request timeout"));
			}, 30000);

			this.pendingGetFriendPubkeyRequests.set(requestId, {
				resolve,
				reject,
				timeout,
			});

			contentWindow.postMessage(
				{ type: "GET_FRIEND_PUBKEY_REQUEST", payload: request },
				this.sigmaUrl,
			);
		});
	}

	/**
	 * Handle messages from Sigma iframe
	 */
	private handleMessage(event: MessageEvent): void {
		// Verify origin
		if (event.origin !== this.sigmaUrl) {
			return;
		}

		const { type, payload } = event.data || {};

		switch (type) {
			case "WALLET_LOCKED":
				// Show iframe for password entry
				if (this.iframe) {
					this.iframe.style.display = "block";
				}
				break;

			case "WALLET_UNLOCKED":
				// Hide iframe
				if (this.iframe) {
					this.iframe.style.display = "none";
				}
				break;

			case "SIGNER_ERROR": {
				// Hide iframe and reject all pending requests
				if (this.iframe) {
					this.iframe.style.display = "none";
				}
				const errorMsg = event.data.error || "Signer error";
				this.rejectAllPending(
					new Error(
						`Signer error: ${errorMsg}. Please sign in to Sigma Identity.`,
					),
				);
				break;
			}

			case "SIGN_RESPONSE": {
				const response = payload as SignatureResponse;
				const pending = this.pendingRequests.get(response.requestId);
				if (pending) {
					clearTimeout(pending.timeout);
					this.pendingRequests.delete(response.requestId);
					if (response.error) {
						pending.reject(new Error(response.error));
					} else {
						pending.resolve(response.authToken);
					}
				}
				break;
			}

			case "SIGN_AIP_RESPONSE": {
				const response = payload as AIPSignResponse;
				const pending = this.pendingAIPRequests.get(response.requestId);
				if (pending) {
					clearTimeout(pending.timeout);
					this.pendingAIPRequests.delete(response.requestId);
					if (response.error) {
						pending.reject(new Error(response.error));
					} else if (response.signedOps) {
						pending.resolve(response.signedOps);
					} else {
						pending.reject(new Error("No signed ops returned"));
					}
				}
				break;
			}

			case "ENCRYPT_RESPONSE": {
				const response = payload as EncryptResponse;
				const pending = this.pendingEncryptRequests.get(response.requestId);
				if (pending) {
					clearTimeout(pending.timeout);
					this.pendingEncryptRequests.delete(response.requestId);
					if (response.error) {
						pending.reject(new Error(response.error));
					} else if (response.encrypted) {
						pending.resolve(response.encrypted);
					} else {
						pending.reject(new Error("No encrypted data returned"));
					}
				}
				break;
			}

			case "DECRYPT_RESPONSE": {
				const response = payload as DecryptResponse;
				const pending = this.pendingDecryptRequests.get(response.requestId);
				if (pending) {
					clearTimeout(pending.timeout);
					this.pendingDecryptRequests.delete(response.requestId);
					if (response.error) {
						pending.reject(new Error(response.error));
					} else if (response.decrypted !== undefined) {
						pending.resolve(response.decrypted);
					} else {
						pending.reject(new Error("No decrypted data returned"));
					}
				}
				break;
			}

			case "GET_FRIEND_PUBKEY_RESPONSE": {
				const response = payload as GetFriendPubkeyResponse;
				const pending = this.pendingGetFriendPubkeyRequests.get(
					response.requestId,
				);
				if (pending) {
					clearTimeout(pending.timeout);
					this.pendingGetFriendPubkeyRequests.delete(response.requestId);
					if (response.error) {
						pending.reject(new Error(response.error));
					} else if (response.publicKey) {
						pending.resolve(response.publicKey);
					} else {
						pending.reject(new Error("No public key returned"));
					}
				}
				break;
			}
		}
	}

	/**
	 * Reject all pending requests
	 */
	private rejectAllPending(error: Error): void {
		for (const [, pending] of this.pendingRequests) {
			clearTimeout(pending.timeout);
			pending.reject(error);
		}
		this.pendingRequests.clear();

		for (const [, pending] of this.pendingAIPRequests) {
			clearTimeout(pending.timeout);
			pending.reject(error);
		}
		this.pendingAIPRequests.clear();

		for (const [, pending] of this.pendingEncryptRequests) {
			clearTimeout(pending.timeout);
			pending.reject(error);
		}
		this.pendingEncryptRequests.clear();

		for (const [, pending] of this.pendingDecryptRequests) {
			clearTimeout(pending.timeout);
			pending.reject(error);
		}
		this.pendingDecryptRequests.clear();

		for (const [, pending] of this.pendingGetFriendPubkeyRequests) {
			clearTimeout(pending.timeout);
			pending.reject(error);
		}
		this.pendingGetFriendPubkeyRequests.clear();
	}

	/**
	 * Check if signer is ready
	 */
	isReady(): boolean {
		return this.initialized && this.iframe !== null;
	}

	/**
	 * Get current identity
	 */
	getIdentity(): string | null {
		return this.currentBapId;
	}

	/**
	 * Cleanup
	 */
	destroy(): void {
		if (this.iframe) {
			document.body.removeChild(this.iframe);
			this.iframe = null;
		}
		if (this.boundMessageHandler) {
			window.removeEventListener("message", this.boundMessageHandler);
			this.boundMessageHandler = null;
		}
		this.initialized = false;
		this.rejectAllPending(new Error("Signer destroyed"));
	}
}
