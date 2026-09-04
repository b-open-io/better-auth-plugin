/**
 * Account signing-key resolution.
 *
 * The variable is SIGMA_ACCOUNT_PRIVATE_KEY (matching accountPubkey /
 * account_pubkey everywhere else). There is deliberately no fallback to
 * the old SIGMA_MEMBER_PRIVATE_KEY name: two names for one secret is
 * ambiguity, and ambiguity in key configuration is how outages happen.
 * Rename the variable when upgrading.
 */
export function resolveAccountPrivateKey(
	configValue?: string,
): string | undefined {
	if (configValue) {
		return configValue;
	}
	return process.env.SIGMA_ACCOUNT_PRIVATE_KEY;
}
