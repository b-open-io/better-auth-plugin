/**
 * Account signing-key resolution with a deprecated-name fallback.
 *
 * The canonical variable is SIGMA_ACCOUNT_PRIVATE_KEY (matching
 * accountPubkey / account_pubkey everywhere else). SIGMA_MEMBER_PRIVATE_KEY
 * keeps working so existing deployments do not break on upgrade, but its
 * first use logs a deprecation warning naming the replacement.
 */

let deprecationWarned = false;

export function resolveAccountPrivateKey(
	configValue?: string,
): string | undefined {
	if (configValue) {
		return configValue;
	}
	const current = process.env.SIGMA_ACCOUNT_PRIVATE_KEY;
	if (current) {
		return current;
	}
	const legacy = process.env.SIGMA_MEMBER_PRIVATE_KEY;
	if (legacy && !deprecationWarned) {
		deprecationWarned = true;
		console.warn(
			"[sigma-auth] SIGMA_MEMBER_PRIVATE_KEY is deprecated; rename it to SIGMA_ACCOUNT_PRIVATE_KEY. Support for the old name will be removed in a future release.",
		);
	}
	return legacy;
}

/** Test-only reset for the deprecation warning latch. */
export function resetAccountPrivateKeyWarning(): void {
	deprecationWarned = false;
}
