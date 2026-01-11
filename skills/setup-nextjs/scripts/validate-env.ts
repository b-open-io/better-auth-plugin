#!/usr/bin/env bun
/**
 * Validate environment variables for Sigma Auth setup.
 * Checks required env vars and validates WIF format.
 */
import fs from "node:fs/promises";
import path from "node:path";

interface EnvReport {
	status: "valid" | "missing" | "invalid";
	variables: {
		NEXT_PUBLIC_SIGMA_CLIENT_ID: EnvVarStatus;
		SIGMA_MEMBER_PRIVATE_KEY: EnvVarStatus;
		NEXT_PUBLIC_SIGMA_AUTH_URL: EnvVarStatus;
	};
	errors: string[];
	warnings: string[];
}

interface EnvVarStatus {
	present: boolean;
	valid: boolean;
	value?: string; // Only show non-sensitive values
	error?: string;
}

function showHelp(): void {
	console.log("Validate environment variables for Sigma Auth setup.");
	console.log("");
	console.log("Usage: bun run validate-env.ts [env-file]");
	console.log("");
	console.log("Arguments:");
	console.log("  env-file  Path to .env file (defaults to .env.local, then .env)");
	console.log("");
	console.log("Output: JSON report of environment variable status");
}

function isValidWIF(wif: string): boolean {
	// WIF format: base58 encoded, starts with 5 (mainnet) or K/L (compressed mainnet)
	// or 9 (testnet) or c (compressed testnet)
	// Length is typically 51-52 characters
	if (!wif || wif.length < 50 || wif.length > 52) return false;

	const validPrefixes = ["5", "K", "L", "9", "c"];
	if (!validPrefixes.includes(wif[0])) return false;

	// Check for valid base58 characters
	const base58Chars = /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/;
	return base58Chars.test(wif);
}

function isValidUrl(url: string): boolean {
	try {
		new URL(url);
		return true;
	} catch {
		return false;
	}
}

async function parseEnvFile(filePath: string): Promise<Record<string, string>> {
	try {
		const content = await fs.readFile(filePath, "utf-8");
		const env: Record<string, string> = {};

		for (const line of content.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;

			const match = trimmed.match(/^([^=]+)=(.*)$/);
			if (match) {
				const key = match[1].trim();
				let value = match[2].trim();
				// Remove quotes if present
				if ((value.startsWith('"') && value.endsWith('"')) ||
					(value.startsWith("'") && value.endsWith("'"))) {
					value = value.slice(1, -1);
				}
				env[key] = value;
			}
		}

		return env;
	} catch {
		return {};
	}
}

async function validateEnv(projectDir: string, envFile?: string): Promise<EnvReport> {
	// Try to find env file
	let envPath: string | null = null;

	if (envFile) {
		envPath = path.resolve(projectDir, envFile);
	} else {
		// Try common locations
		const locations = [".env.local", ".env"];
		for (const loc of locations) {
			const fullPath = path.join(projectDir, loc);
			try {
				await fs.access(fullPath);
				envPath = fullPath;
				break;
			} catch {}
		}
	}

	// Combine file env with process.env
	let fileEnv: Record<string, string> = {};
	if (envPath) {
		fileEnv = await parseEnvFile(envPath);
	}

	const env = { ...fileEnv, ...process.env };

	const errors: string[] = [];
	const warnings: string[] = [];

	// Validate NEXT_PUBLIC_SIGMA_CLIENT_ID
	const clientId = env.NEXT_PUBLIC_SIGMA_CLIENT_ID;
	const clientIdStatus: EnvVarStatus = {
		present: Boolean(clientId),
		valid: Boolean(clientId && clientId.length > 0),
		value: clientId,
	};
	if (!clientIdStatus.present) {
		errors.push("NEXT_PUBLIC_SIGMA_CLIENT_ID is not set");
	} else if (!clientIdStatus.valid) {
		errors.push("NEXT_PUBLIC_SIGMA_CLIENT_ID is empty");
	}

	// Validate SIGMA_MEMBER_PRIVATE_KEY
	const privateKey = env.SIGMA_MEMBER_PRIVATE_KEY;
	const privateKeyStatus: EnvVarStatus = {
		present: Boolean(privateKey),
		valid: Boolean(privateKey && isValidWIF(privateKey)),
	};
	if (!privateKeyStatus.present) {
		errors.push("SIGMA_MEMBER_PRIVATE_KEY is not set");
	} else if (!privateKeyStatus.valid) {
		privateKeyStatus.error = "Invalid WIF format";
		errors.push("SIGMA_MEMBER_PRIVATE_KEY is not a valid WIF (Wallet Import Format)");
	}

	// Validate NEXT_PUBLIC_SIGMA_AUTH_URL
	const authUrl = env.NEXT_PUBLIC_SIGMA_AUTH_URL;
	const authUrlStatus: EnvVarStatus = {
		present: Boolean(authUrl),
		valid: Boolean(authUrl && isValidUrl(authUrl)),
		value: authUrl,
	};
	if (!authUrlStatus.present) {
		warnings.push("NEXT_PUBLIC_SIGMA_AUTH_URL not set, will default to https://auth.sigmaidentity.com");
		authUrlStatus.valid = true; // Not an error, just uses default
	} else if (!authUrlStatus.valid) {
		authUrlStatus.error = "Invalid URL format";
		errors.push("NEXT_PUBLIC_SIGMA_AUTH_URL is not a valid URL");
	}

	// Determine overall status
	let status: EnvReport["status"] = "valid";
	if (errors.length > 0) {
		status = errors.some(e => e.includes("not set")) ? "missing" : "invalid";
	}

	return {
		status,
		variables: {
			NEXT_PUBLIC_SIGMA_CLIENT_ID: clientIdStatus,
			SIGMA_MEMBER_PRIVATE_KEY: privateKeyStatus,
			NEXT_PUBLIC_SIGMA_AUTH_URL: authUrlStatus,
		},
		errors,
		warnings,
	};
}

// Parse command line arguments
const args = process.argv.slice(2);

// Handle --help flag
if (args.includes("--help") || args.includes("-h")) {
	showHelp();
	process.exit(0);
}

const envFile = args[0];
const projectDir = process.cwd();

validateEnv(projectDir, envFile)
	.then((report) => {
		console.log(JSON.stringify(report, null, 2));
		process.exit(report.status === "valid" ? 0 : 1);
	})
	.catch((error) => {
		console.error("❌ Error:", error.message);
		process.exit(1);
	});
