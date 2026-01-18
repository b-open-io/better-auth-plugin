/**
 * Sync Client for local signers → Sigma-Auth backup synchronization
 *
 * Uses bitcoin-auth tokens signed by BAP member key for authentication.
 * Pushes/pulls encrypted BapMasterBackup format to cloud storage.
 */

import { getAuthToken } from "bitcoin-auth";
import type { BAP } from "bsv-bap";

const SYNC_ENDPOINT = "/api/backup/sync";

export interface SyncConfig {
	/** Sigma-auth server URL (e.g., "https://sigmaidentity.com") */
	serverUrl: string;
}

export interface SyncResult {
	success: boolean;
	error?: string;
	encryptedBackup?: string;
	lastUpdated?: string;
}

/**
 * Get the WIF (private key) for the primary BAP identity's member key
 */
function getMemberWif(bap: BAP, bapId: string): string {
	const identity = bap.getId(bapId);
	if (!identity) {
		throw new Error(`Identity ${bapId} not found in BAP`);
	}

	const memberData = identity.exportMember();
	if (!memberData?.wif) {
		throw new Error("Failed to export member WIF");
	}

	return memberData.wif;
}

/**
 * Create a bitcoin-auth token for sync authentication
 */
function createSyncAuthToken(
	wif: string,
	requestPath: string,
	body?: string,
): string {
	return getAuthToken({
		privateKeyWif: wif,
		requestPath,
		body,
	});
}

/**
 * Push encrypted backup to sigma-auth cloud storage
 */
export async function pushBackup(
	bap: BAP,
	bapId: string,
	encryptedBackup: string,
	config: SyncConfig,
): Promise<SyncResult> {
	try {
		const wif = getMemberWif(bap, bapId);

		const body = JSON.stringify({ bapId, encryptedBackup });
		const authToken = createSyncAuthToken(wif, SYNC_ENDPOINT, body);

		const response = await fetch(`${config.serverUrl}${SYNC_ENDPOINT}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bitcoin-Auth ${authToken}`,
			},
			body,
		});

		const data = await response.json();

		if (!response.ok) {
			return {
				success: false,
				error: data.message || data.error || `HTTP ${response.status}`,
			};
		}

		return { success: true };
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Unknown error",
		};
	}
}

/**
 * Pull encrypted backup from sigma-auth cloud storage
 */
export async function pullBackup(
	bap: BAP,
	bapId: string,
	config: SyncConfig,
): Promise<SyncResult> {
	try {
		const wif = getMemberWif(bap, bapId);

		const authToken = createSyncAuthToken(wif, SYNC_ENDPOINT);

		const response = await fetch(
			`${config.serverUrl}${SYNC_ENDPOINT}?bapId=${encodeURIComponent(bapId)}`,
			{
				method: "GET",
				headers: {
					Authorization: `Bitcoin-Auth ${authToken}`,
				},
			},
		);

		const data = await response.json();

		if (!response.ok) {
			return {
				success: false,
				error: data.message || data.error || `HTTP ${response.status}`,
			};
		}

		return {
			success: true,
			encryptedBackup: data.encryptedBackup,
			lastUpdated: data.lastUpdated,
		};
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Unknown error",
		};
	}
}

/**
 * Check if cloud backup exists and get its timestamp
 */
export async function checkBackupStatus(
	bap: BAP,
	bapId: string,
	config: SyncConfig,
): Promise<{ exists: boolean; lastUpdated?: string; error?: string }> {
	const result = await pullBackup(bap, bapId, config);

	if (result.success) {
		return {
			exists: true,
			lastUpdated: result.lastUpdated,
		};
	}

	// 404 means no backup exists (not an error)
	if (result.error?.includes("404") || result.error?.includes("not_found")) {
		return { exists: false };
	}

	return { exists: false, error: result.error };
}
