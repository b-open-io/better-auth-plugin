#!/usr/bin/env bun
/**
 * Health check for Sigma Auth integration.
 * Tests connection to auth server and validates OAuth client.
 */

interface HealthReport {
	status: "healthy" | "degraded" | "unhealthy";
	checks: {
		authServer: CheckResult;
		wellKnown: CheckResult;
		jwks: CheckResult;
	};
	authServerInfo?: {
		issuer: string;
		authorizationEndpoint: string;
		tokenEndpoint: string;
	};
	errors: string[];
}

interface CheckResult {
	status: "pass" | "fail" | "skip";
	latencyMs?: number;
	error?: string;
}

function showHelp(): void {
	console.log("Health check for Sigma Auth integration.");
	console.log("");
	console.log("Usage: bun run health-check.ts [auth-url]");
	console.log("");
	console.log("Arguments:");
	console.log("  auth-url  Sigma Auth server URL (defaults to https://auth.sigmaidentity.com)");
	console.log("");
	console.log("Output: JSON report of health check results");
}

async function checkEndpoint(url: string, name: string): Promise<CheckResult> {
	const start = Date.now();
	try {
		const response = await fetch(url, {
			method: "GET",
			headers: { Accept: "application/json" },
		});

		const latencyMs = Date.now() - start;

		if (response.ok) {
			return { status: "pass", latencyMs };
		}
		return {
			status: "fail",
			latencyMs,
			error: `HTTP ${response.status}: ${response.statusText}`,
		};
	} catch (error: any) {
		return {
			status: "fail",
			latencyMs: Date.now() - start,
			error: error.message,
		};
	}
}

async function fetchJson(url: string): Promise<any> {
	const response = await fetch(url, {
		headers: { Accept: "application/json" },
	});
	if (!response.ok) {
		throw new Error(`HTTP ${response.status}`);
	}
	return response.json();
}

async function healthCheck(authUrl: string): Promise<HealthReport> {
	const errors: string[] = [];

	// Normalize URL
	authUrl = authUrl.replace(/\/$/, "");

	// Check auth server is reachable
	const authServerCheck = await checkEndpoint(authUrl, "auth server");
	if (authServerCheck.status === "fail") {
		errors.push(`Auth server unreachable: ${authServerCheck.error}`);
	}

	// Check .well-known/openid-configuration (Better Auth uses /api/auth prefix)
	const wellKnownUrl = `${authUrl}/api/auth/.well-known/openid-configuration`;
	const wellKnownCheck = await checkEndpoint(wellKnownUrl, "well-known");
	let authServerInfo: HealthReport["authServerInfo"] | undefined;

	if (wellKnownCheck.status === "pass") {
		try {
			const config = await fetchJson(wellKnownUrl);
			authServerInfo = {
				issuer: config.issuer,
				authorizationEndpoint: config.authorization_endpoint,
				tokenEndpoint: config.token_endpoint,
			};
		} catch (error: any) {
			wellKnownCheck.status = "fail";
			wellKnownCheck.error = `Failed to parse: ${error.message}`;
			errors.push(`OpenID configuration invalid: ${error.message}`);
		}
	} else {
		errors.push(`OpenID configuration unavailable: ${wellKnownCheck.error}`);
	}

	// Check JWKS endpoint
	let jwksCheck: CheckResult = { status: "skip" };
	if (authServerInfo) {
		const jwksUrl = `${authUrl}/api/auth/jwks`;
		jwksCheck = await checkEndpoint(jwksUrl, "jwks");
		if (jwksCheck.status === "fail") {
			errors.push(`JWKS endpoint unavailable: ${jwksCheck.error}`);
		}
	}

	// Determine overall status
	let status: HealthReport["status"] = "healthy";
	if (authServerCheck.status === "fail") {
		status = "unhealthy";
	} else if (wellKnownCheck.status === "fail" || jwksCheck.status === "fail") {
		status = "degraded";
	}

	return {
		status,
		checks: {
			authServer: authServerCheck,
			wellKnown: wellKnownCheck,
			jwks: jwksCheck,
		},
		authServerInfo,
		errors,
	};
}

// Parse command line arguments
const args = process.argv.slice(2);

// Handle --help flag
if (args.includes("--help") || args.includes("-h")) {
	showHelp();
	process.exit(0);
}

const authUrl = args[0] ||
	process.env.NEXT_PUBLIC_SIGMA_AUTH_URL ||
	"https://auth.sigmaidentity.com";

healthCheck(authUrl)
	.then((report) => {
		console.log(JSON.stringify(report, null, 2));
		process.exit(report.status === "healthy" ? 0 : 1);
	})
	.catch((error) => {
		console.error("❌ Error:", error.message);
		process.exit(1);
	});
