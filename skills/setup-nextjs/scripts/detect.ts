#!/usr/bin/env bun
/**
 * Detect project structure for Sigma Auth setup.
 * Returns JSON report about the project's framework, directories, and configuration.
 */
import fs from "node:fs/promises";
import path from "node:path";

interface ProjectReport {
	framework: "nextjs-app" | "nextjs-pages" | "payload" | "unknown";
	packageManager: "bun" | "npm" | "yarn" | "pnpm" | "unknown";
	directories: {
		app?: string;
		pages?: string;
		lib?: string;
		src?: string;
		api?: string;
	};
	existingAuth: {
		hasAuthClient: boolean;
		hasCallbackRoute: boolean;
		hasSigmaPlugin: boolean;
	};
	dependencies: {
		hasBetterAuth: boolean;
		hasSigmaPlugin: boolean;
	};
	recommendations: string[];
}

function showHelp(): void {
	console.log("Detect project structure for Sigma Auth setup.");
	console.log("");
	console.log("Usage: bun run detect.ts [project-dir]");
	console.log("");
	console.log("Arguments:");
	console.log("  project-dir  Path to project (defaults to current directory)");
	console.log("");
	console.log("Output: JSON report of project structure");
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

async function readJson(filePath: string): Promise<any> {
	try {
		const content = await fs.readFile(filePath, "utf-8");
		return JSON.parse(content);
	} catch {
		return null;
	}
}

async function detectPackageManager(projectDir: string): Promise<ProjectReport["packageManager"]> {
	if (await fileExists(path.join(projectDir, "bun.lockb"))) return "bun";
	if (await fileExists(path.join(projectDir, "bun.lock"))) return "bun";
	if (await fileExists(path.join(projectDir, "yarn.lock"))) return "yarn";
	if (await fileExists(path.join(projectDir, "pnpm-lock.yaml"))) return "pnpm";
	if (await fileExists(path.join(projectDir, "package-lock.json"))) return "npm";
	return "unknown";
}

async function detectFramework(projectDir: string): Promise<ProjectReport["framework"]> {
	const pkg = await readJson(path.join(projectDir, "package.json"));
	if (!pkg) return "unknown";

	// Check for Payload CMS
	if (pkg.dependencies?.payload || pkg.devDependencies?.payload) {
		return "payload";
	}

	// Check for Next.js
	if (pkg.dependencies?.next || pkg.devDependencies?.next) {
		// Check for app router vs pages router
		if (await fileExists(path.join(projectDir, "app"))) return "nextjs-app";
		if (await fileExists(path.join(projectDir, "src/app"))) return "nextjs-app";
		if (await fileExists(path.join(projectDir, "pages"))) return "nextjs-pages";
		if (await fileExists(path.join(projectDir, "src/pages"))) return "nextjs-pages";
		return "nextjs-app"; // Default to app router for modern Next.js
	}

	return "unknown";
}

async function detectDirectories(projectDir: string): Promise<ProjectReport["directories"]> {
	const dirs: ProjectReport["directories"] = {};

	// Check for app directory
	if (await fileExists(path.join(projectDir, "app"))) {
		dirs.app = "app";
	} else if (await fileExists(path.join(projectDir, "src/app"))) {
		dirs.app = "src/app";
	}

	// Check for pages directory
	if (await fileExists(path.join(projectDir, "pages"))) {
		dirs.pages = "pages";
	} else if (await fileExists(path.join(projectDir, "src/pages"))) {
		dirs.pages = "src/pages";
	}

	// Check for lib directory
	if (await fileExists(path.join(projectDir, "lib"))) {
		dirs.lib = "lib";
	} else if (await fileExists(path.join(projectDir, "src/lib"))) {
		dirs.lib = "src/lib";
	}

	// Check for src directory
	if (await fileExists(path.join(projectDir, "src"))) {
		dirs.src = "src";
	}

	// Check for api directory
	if (dirs.app && await fileExists(path.join(projectDir, dirs.app, "api"))) {
		dirs.api = `${dirs.app}/api`;
	} else if (dirs.pages && await fileExists(path.join(projectDir, dirs.pages, "api"))) {
		dirs.api = `${dirs.pages}/api`;
	}

	return dirs;
}

async function detectExistingAuth(projectDir: string, dirs: ProjectReport["directories"]): Promise<ProjectReport["existingAuth"]> {
	const result = {
		hasAuthClient: false,
		hasCallbackRoute: false,
		hasSigmaPlugin: false,
	};

	// Check for auth client
	const authLocations = [
		path.join(projectDir, "lib/auth.ts"),
		path.join(projectDir, "lib/auth.tsx"),
		path.join(projectDir, "src/lib/auth.ts"),
		path.join(projectDir, "src/lib/auth.tsx"),
	];

	for (const loc of authLocations) {
		if (await fileExists(loc)) {
			result.hasAuthClient = true;
			try {
				const content = await fs.readFile(loc, "utf-8");
				if (content.includes("sigma") || content.includes("Sigma")) {
					result.hasSigmaPlugin = true;
				}
			} catch {}
			break;
		}
	}

	// Check for callback route
	const callbackLocations = [
		path.join(projectDir, "app/auth/sigma/callback/page.tsx"),
		path.join(projectDir, "app/api/auth/sigma/callback/route.ts"),
		path.join(projectDir, "src/app/auth/sigma/callback/page.tsx"),
		path.join(projectDir, "src/app/api/auth/sigma/callback/route.ts"),
		path.join(projectDir, "pages/api/auth/callback/sigma.ts"),
	];

	for (const loc of callbackLocations) {
		if (await fileExists(loc)) {
			result.hasCallbackRoute = true;
			break;
		}
	}

	return result;
}

async function detectDependencies(projectDir: string): Promise<ProjectReport["dependencies"]> {
	const pkg = await readJson(path.join(projectDir, "package.json"));
	if (!pkg) {
		return { hasBetterAuth: false, hasSigmaPlugin: false };
	}

	const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

	return {
		hasBetterAuth: Boolean(allDeps["better-auth"]),
		hasSigmaPlugin: Boolean(allDeps["@sigma-auth/better-auth-plugin"]),
	};
}

function generateRecommendations(report: Omit<ProjectReport, "recommendations">): string[] {
	const recommendations: string[] = [];

	if (report.framework === "unknown") {
		recommendations.push("Could not detect framework. Ensure this is a Next.js or Payload CMS project.");
	}

	if (!report.dependencies.hasBetterAuth) {
		const pm = report.packageManager === "unknown" ? "bun" : report.packageManager;
		recommendations.push(`Install better-auth: ${pm} add better-auth`);
	}

	if (!report.dependencies.hasSigmaPlugin) {
		const pm = report.packageManager === "unknown" ? "bun" : report.packageManager;
		recommendations.push(`Install Sigma Auth plugin: ${pm} add @sigma-auth/better-auth-plugin`);
	}

	if (!report.existingAuth.hasAuthClient) {
		const libDir = report.directories.lib || "lib";
		recommendations.push(`Create auth client at ${libDir}/auth.ts`);
	}

	if (!report.existingAuth.hasCallbackRoute) {
		if (report.framework === "nextjs-app") {
			const appDir = report.directories.app || "app";
			recommendations.push(`Create callback page at ${appDir}/auth/sigma/callback/page.tsx`);
			recommendations.push(`Create API route at ${appDir}/api/auth/sigma/callback/route.ts`);
		} else if (report.framework === "nextjs-pages") {
			recommendations.push("Create callback API at pages/api/auth/callback/sigma.ts");
		}
	}

	if (recommendations.length === 0) {
		recommendations.push("Project appears to be fully configured for Sigma Auth!");
	}

	return recommendations;
}

async function detect(projectDir: string): Promise<ProjectReport> {
	const framework = await detectFramework(projectDir);
	const packageManager = await detectPackageManager(projectDir);
	const directories = await detectDirectories(projectDir);
	const existingAuth = await detectExistingAuth(projectDir, directories);
	const dependencies = await detectDependencies(projectDir);

	const partialReport = {
		framework,
		packageManager,
		directories,
		existingAuth,
		dependencies,
	};

	return {
		...partialReport,
		recommendations: generateRecommendations(partialReport),
	};
}

// Parse command line arguments
const args = process.argv.slice(2);

// Handle --help flag
if (args.includes("--help") || args.includes("-h")) {
	showHelp();
	process.exit(0);
}

const projectDir = args[0] ? path.resolve(args[0]) : process.cwd();

detect(projectDir)
	.then((report) => {
		console.log(JSON.stringify(report, null, 2));
	})
	.catch((error) => {
		console.error("❌ Error:", error.message);
		process.exit(1);
	});
