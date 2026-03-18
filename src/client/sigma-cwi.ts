/**
 * Sigma CWI Signer
 *
 * Implements the SigmaSigner interface using CWI (Client Wallet Interface)
 * protocol over postMessage to a hidden iframe at the Sigma auth server.
 *
 * Standard wallet operations (encrypt, decrypt, getPublicKey) use CWI calls.
 * Sigma-specific operations (sign, signAIP) use custom CWI calls
 * since they don't map to standard WalletInterface methods.
 */

import type { SigmaSigner } from "./local-signer.js";

interface PendingRequest<T = unknown> {
	resolve: (value: T) => void;
	reject: (error: Error) => void;
	timeout: ReturnType<typeof setTimeout>;
}

interface CWIRequestMessage {
	type: "CWI";
	isInvocation: true;
	id: string;
	call: string;
	args?: unknown;
}

interface CWIResponseMessage {
	type: "CWI";
	isInvocation: false;
	id: string;
	result?: unknown;
	status?: "error";
	description?: string;
	code?: number;
}

interface CWIStateMessage {
	type: "CWI";
	cwiState: {
		status?: string;
		hasPermission?: boolean;
	};
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null;

const isResponse = (v: unknown): v is CWIResponseMessage =>
	isRecord(v) &&
	v.type === "CWI" &&
	v.isInvocation === false &&
	typeof v.id === "string";

const isState = (v: unknown): v is CWIStateMessage =>
	isRecord(v) && v.type === "CWI" && isRecord(v.cwiState);

const createId = (): string =>
	typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
		? crypto.randomUUID()
		: `${Date.now()}-${Math.random().toString(36).slice(2, 14)}`;

const DEFAULT_TIMEOUT_MS = 30_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;

export class SigmaCWISigner implements SigmaSigner {
	private iframe: HTMLIFrameElement | null = null;
	private pending = new Map<string, PendingRequest>();
	private initialized = false;
	private destroyed = false;
	private currentBapId: string | null = null;
	private sigmaUrl: string;
	private sigmaOrigin: string;
	private handshakeResolve: (() => void) | null = null;
	private handshakeReject: ((err: Error) => void) | null = null;
	private handshakeComplete = false;
	private boundMessageHandler: ((event: MessageEvent) => void) | null = null;

	constructor(sigmaUrl: string) {
		this.sigmaUrl = sigmaUrl;
		this.sigmaOrigin = new URL(sigmaUrl).origin;
	}

	async init(): Promise<void> {
		if (typeof window === "undefined") {
			throw new Error("SigmaCWISigner can only be used in browser");
		}

		if (this.initialized) return;

		this.iframe = document.createElement("iframe");
		this.iframe.src = `${this.sigmaUrl}/signer`;
		this.iframe.setAttribute("aria-hidden", "true");
		this.iframe.style.cssText = `
			position: fixed;
			top: 0;
			left: 0;
			width: 0;
			height: 0;
			border: 0;
			opacity: 0;
			pointer-events: none;
			z-index: 2147483647;
		`;
		document.body.appendChild(this.iframe);

		this.boundMessageHandler = this.handleMessage.bind(this);
		window.addEventListener("message", this.boundMessageHandler);

		await this.waitForHandshake();
		this.initialized = true;
	}

	private waitForHandshake(): Promise<void> {
		if (this.handshakeComplete) return Promise.resolve();

		return new Promise<void>((resolve, reject) => {
			this.handshakeResolve = resolve;
			this.handshakeReject = reject;

			setTimeout(() => {
				if (!this.handshakeComplete) {
					this.handshakeReject?.(new Error("Sigma signer handshake timed out"));
					this.handshakeResolve = null;
					this.handshakeReject = null;
				}
			}, HANDSHAKE_TIMEOUT_MS);
		});
	}

	private handleMessage(event: MessageEvent): void {
		if (this.destroyed) return;
		if (event.origin !== this.sigmaOrigin) return;

		const data = event.data;

		if (isState(data)) {
			const { status, hasPermission } = data.cwiState;

			if (status === "need_password" || hasPermission) {
				this.showIframe();
			} else {
				this.hideIframe();
			}

			if (!this.handshakeComplete) {
				this.handshakeComplete = true;
				this.handshakeResolve?.();
				this.handshakeResolve = null;
				this.handshakeReject = null;
			}

			if (status === "error") {
				this.rejectAllPending(
					new Error("Signer error. Please sign in to Sigma Identity."),
				);
			}

			return;
		}

		if (!isResponse(data)) return;

		const req = this.pending.get(data.id);
		if (!req) return;

		this.pending.delete(data.id);
		clearTimeout(req.timeout);

		if (data.status === "error") {
			req.reject(new Error(data.description ?? "CWI request failed"));
		} else {
			req.resolve(data.result);
		}
	}

	private showIframe(): void {
		if (!this.iframe) return;
		this.iframe.style.width = "100%";
		this.iframe.style.height = "100%";
		this.iframe.style.opacity = "1";
		this.iframe.style.pointerEvents = "auto";
	}

	private hideIframe(): void {
		if (!this.iframe) return;
		this.iframe.style.width = "0";
		this.iframe.style.height = "0";
		this.iframe.style.opacity = "0";
		this.iframe.style.pointerEvents = "none";
	}

	private sendCWI<T>(call: string, args?: unknown): Promise<T> {
		if (this.destroyed) {
			return Promise.reject(new Error("SigmaCWISigner has been destroyed"));
		}

		const contentWindow = this.iframe?.contentWindow;
		if (!contentWindow) {
			return Promise.reject(new Error("Sigma iframe not accessible"));
		}

		const id = createId();
		const request: CWIRequestMessage = {
			type: "CWI",
			isInvocation: true,
			id,
			call,
			args,
		};

		return new Promise<T>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`CWI request timed out: ${call}`));
			}, DEFAULT_TIMEOUT_MS);

			this.pending.set(id, {
				resolve: resolve as (value: unknown) => void,
				reject,
				timeout,
			});

			contentWindow.postMessage(request, this.sigmaOrigin);
		});
	}

	private sendCustomMessage(type: string, payload: unknown): void {
		const contentWindow = this.iframe?.contentWindow;
		if (!contentWindow) return;
		contentWindow.postMessage({ type, payload }, this.sigmaOrigin);
	}

	private ensureIdentity(): void {
		if (!this.currentBapId) {
			throw new Error("No identity set. Call setIdentity() first.");
		}
	}

	private async ensureReady(): Promise<void> {
		if (!this.initialized) {
			await this.init();
		}
		this.ensureIdentity();
		this.sendCustomMessage("SET_IDENTITY", { bapId: this.currentBapId });
	}

	setIdentity(bapId: string): void {
		this.currentBapId = bapId;

		if (this.initialized && this.iframe?.contentWindow) {
			this.sendCustomMessage("SET_IDENTITY", { bapId });
		}
	}

	getIdentity(): string | null {
		return this.currentBapId;
	}

	async sign(
		requestPath: string,
		body?: string,
		signatureType: "bsm" | "brc77" = "brc77",
	): Promise<string> {
		await this.ensureReady();

		return this.sendCWI<string>("signAuthToken", {
			requestPath,
			body,
			signatureType,
		});
	}

	async signAIP(hexArray: string[]): Promise<string[]> {
		await this.ensureReady();

		return this.sendCWI<string[]>("signAIP", { hexArray });
	}

	async encrypt(
		data: string,
		friendBapId: string,
		theirPublicKey?: string,
	): Promise<string> {
		await this.ensureReady();

		const result = await this.sendCWI<{ ciphertext: Uint8Array }>("encrypt", {
			plaintext: new TextEncoder().encode(data),
			protocolID: [2, "sigma-encrypt"],
			keyID: friendBapId,
			counterparty: theirPublicKey,
		});

		return btoa(
			String.fromCharCode(...new Uint8Array(Object.values(result.ciphertext))),
		);
	}

	async decrypt(
		ciphertext: string,
		friendBapId: string,
		theirPublicKey?: string,
	): Promise<string> {
		await this.ensureReady();

		const ciphertextBytes = Uint8Array.from(atob(ciphertext), (c) =>
			c.charCodeAt(0),
		);

		const result = await this.sendCWI<{ plaintext: Uint8Array }>("decrypt", {
			ciphertext: ciphertextBytes,
			protocolID: [2, "sigma-encrypt"],
			keyID: friendBapId,
			counterparty: theirPublicKey,
		});

		return new TextDecoder().decode(
			new Uint8Array(Object.values(result.plaintext)),
		);
	}

	async getFriendPublicKey(friendBapId: string): Promise<string> {
		await this.ensureReady();

		const result = await this.sendCWI<{ publicKey: string }>("getPublicKey", {
			protocolID: [2, "sigma-encrypt"],
			keyID: friendBapId,
		});

		return result.publicKey;
	}

	isReady(): boolean {
		return this.initialized && !this.destroyed && this.iframe !== null;
	}

	destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;

		if (this.boundMessageHandler) {
			window.removeEventListener("message", this.boundMessageHandler);
			this.boundMessageHandler = null;
		}

		this.rejectAllPending(new Error("Signer destroyed"));

		if (this.iframe?.parentNode) {
			this.iframe.parentNode.removeChild(this.iframe);
		}
		this.iframe = null;
		this.initialized = false;
	}

	private rejectAllPending(error: Error): void {
		for (const [, req] of this.pending) {
			clearTimeout(req.timeout);
			req.reject(error);
		}
		this.pending.clear();
	}
}
