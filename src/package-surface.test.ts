/**
 * Publish-surface tests: what actually ships, and whether it resolves.
 *
 * The rest of the suite runs inside this workspace, where Bun has flattened
 * every transitive package to the top level. That hides a whole class of bug:
 * an entry point can import a package this one never declared, resolve fine
 * here, and throw `ERR_MODULE_NOT_FOUND` for a consumer on pnpm's strict
 * layout, Yarn PnP, or any nested install. `@better-auth/utils`,
 * `@better-auth/core` and `@better-fetch/fetch` were all being imported that
 * way.
 *
 * So these tests do three things the others cannot:
 *  1. build and `npm pack` the real artifact, and inspect the shipped file list
 *  2. parse every shipped `.js` and `.d.ts` with TypeScript's own scanner —
 *     which sees `import type` and dynamic `import()`, and ignores comments —
 *     and require every bare specifier to be declared
 *  3. install the packed tarball into an isolated fixture whose `node_modules`
 *     contains *only* the declared dependencies, and import every entry point
 *     from it under Node's own ESM resolver
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";

const REPO = resolve(import.meta.dir, "..");
const PKG_NAME = "@sigma-auth/better-auth-plugin";

interface Manifest {
	name: string;
	version: string;
	files?: string[];
	exports: Record<string, { types?: string; import?: string }>;
	dependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	peerDependenciesMeta?: Record<string, { optional?: boolean } | undefined>;
	optionalDependencies?: Record<string, string>;
}

let manifest: Manifest;
let scratch: string;
/** Extracted tarball root (`<scratch>/pkg/package`). */
let packageRoot: string;
/** Paths inside the tarball, relative to the package root. */
let packedFiles: string[];
/** `<scratch>/fixture` — a node_modules tree holding only declared deps. */
let fixture: string;

function run(command: string, args: string[], cwd: string) {
	const result = spawnSync(command, args, { cwd, encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(
			`${command} ${args.join(" ")} failed (${result.status}):\n${result.stdout}\n${result.stderr}`,
		);
	}
	return result.stdout;
}

beforeAll(async () => {
	manifest = (await Bun.file(join(REPO, "package.json")).json()) as Manifest;
	scratch = await mkdtemp(join(tmpdir(), "sigma-auth-surface-"));

	// Build exactly as `bun run build` does, so the artifact under test is the
	// artifact that would ship rather than whatever happens to be on disk.
	run("bunx", ["tsc", "-p", "tsconfig.json"], REPO);

	const packDir = join(scratch, "pkg");
	await mkdir(packDir, { recursive: true });
	const packOutput = run(
		"npm",
		["pack", "--pack-destination", packDir, "--json", "--silent"],
		REPO,
	);
	const tarball = join(
		packDir,
		(JSON.parse(packOutput) as Array<{ filename: string }>)[0]?.filename ?? "",
	);
	expect(existsSync(tarball)).toBe(true);

	packedFiles = run("tar", ["-tzf", tarball], packDir)
		.split("\n")
		.filter(Boolean)
		.map((entry) => entry.replace(/^package\//, ""))
		.filter((entry) => !entry.endsWith("/"));

	run("tar", ["-xzf", tarball], packDir);
	packageRoot = join(packDir, "package");

	// Isolated fixture: only what the manifest declares gets a node_modules
	// entry. Symlinked packages still resolve *their* own dependencies from the
	// workspace via realpath, which is what a real install gives them; the
	// package under test is copied, so its own resolution starts here.
	fixture = join(scratch, "fixture");
	const fixtureModules = join(fixture, "node_modules");
	await mkdir(fixtureModules, { recursive: true });
	await writeFile(
		join(fixture, "package.json"),
		JSON.stringify({ name: "fixture", private: true, type: "module" }, null, 2),
	);

	const declared = [
		...Object.keys(manifest.dependencies ?? {}),
		...Object.keys(manifest.peerDependencies ?? {}),
		...Object.keys(manifest.optionalDependencies ?? {}),
	];
	for (const name of declared) {
		const source = join(REPO, "node_modules", name);
		if (!existsSync(source)) continue; // optional peer, not installed here
		const target = join(fixtureModules, name);
		await mkdir(dirname(target), { recursive: true });
		await symlink(source, target, "dir");
	}

	const installed = join(fixtureModules, PKG_NAME);
	await mkdir(dirname(installed), { recursive: true });
	run("cp", ["-R", packageRoot, installed], scratch);
});

afterAll(async () => {
	if (scratch) await rm(scratch, { recursive: true, force: true });
});

/**
 * Node's own ESM resolver, not Bun's: consumers install with npm/pnpm/yarn and
 * run on Node, and Node is the stricter of the two. Falls back to the current
 * runtime only if the machine has no `node`.
 */
const nodeBinary =
	spawnSync("node", ["-v"], { encoding: "utf8" }).status === 0
		? "node"
		: process.execPath;
const MODULE_NOT_FOUND = /ERR_MODULE_NOT_FOUND|Cannot find (module|package)/;

/** `@scope/name/deep/path` -> `@scope/name`; `name/deep` -> `name`. */
function packageNameOf(specifier: string): string {
	const segments = specifier.split("/");
	if (specifier.startsWith("@")) return segments.slice(0, 2).join("/");
	return segments[0] ?? specifier;
}

describe("packed artifact", () => {
	test("ships every file the exports map points at", () => {
		const targets = new Set<string>();
		for (const entry of Object.values(manifest.exports)) {
			if (entry.types) targets.add(entry.types.replace(/^\.\//, ""));
			if (entry.import) targets.add(entry.import.replace(/^\.\//, ""));
		}
		expect(targets.size).toBeGreaterThan(0);
		for (const target of targets) {
			expect(packedFiles).toContain(target);
		}
	});

	test("ships the manifest and README and nothing test-related", () => {
		expect(packedFiles).toContain("package.json");
		expect(packedFiles).toContain("README.md");
		expect(packedFiles.filter((f) => /\.test\./.test(f))).toEqual([]);
		expect(packedFiles.filter((f) => f.startsWith("src/"))).toEqual([]);
	});
});

describe("declared dependency surface", () => {
	test("every bare specifier in the shipped artifact is declared", async () => {
		const declared = new Set([
			...Object.keys(manifest.dependencies ?? {}),
			...Object.keys(manifest.peerDependencies ?? {}),
			...Object.keys(manifest.optionalDependencies ?? {}),
			manifest.name,
		]);
		const builtins = new Set(builtinModules);

		const shipped = packedFiles.filter(
			(f) => f.endsWith(".js") || f.endsWith(".d.ts"),
		);
		expect(shipped.length).toBeGreaterThan(0);

		const undeclared: string[] = [];
		for (const relative of shipped) {
			const text = await Bun.file(join(packageRoot, relative)).text();
			// TypeScript's own preprocessor: sees `import type` and dynamic
			// `import()`, and does not see specifiers inside JSDoc examples.
			for (const ref of ts.preProcessFile(text, true, true).importedFiles) {
				const specifier = ref.fileName;
				if (specifier.startsWith(".") || specifier.startsWith("/")) continue;
				const name = packageNameOf(specifier);
				if (name.startsWith("node:") || builtins.has(name)) continue;
				if (declared.has(name)) continue;
				undeclared.push(`${relative}: ${specifier}`);
			}
		}

		expect(undeclared).toEqual([]);
	});
});

/**
 * What a consumer following the README would actually have installed, per entry
 * point. The base set is every *non-optional* peer plus this package's own
 * dependencies — the things every consumer gets. The per-entry extras are the
 * optional peers the README tells you to add for that specific import.
 *
 * Deliberately a hand-maintained table rather than something derived from the
 * artifact: derivation would make the test agree with the code by construction
 * and prove nothing. Two assertions below keep it honest against the manifest,
 * and the fixtures below prove it against Node and `tsc`.
 */
const ENTRY_EXTRAS: Record<string, string[]> = {
	".": [],
	"./client": ["@better-fetch/fetch"],
	"./client/local": [],
	"./client/sync": ["bsv-bap"],
	"./server": [],
	"./server/local": [],
	"./next": [],
	"./payload": [],
	"./provider": ["@bsv/sdk", "@neondatabase/serverless"],
};

describe("documented install matrix", () => {
	test("covers exactly the exported entry points", () => {
		expect(Object.keys(ENTRY_EXTRAS).sort()).toEqual(
			Object.keys(manifest.exports).sort(),
		);
	});

	test("every per-entry extra is a declared optional peer", () => {
		const optional = new Set(
			Object.entries(manifest.peerDependenciesMeta ?? {})
				.filter(([, meta]) => meta?.optional)
				.map(([name]) => name),
		);
		const extras = new Set(Object.values(ENTRY_EXTRAS).flat());
		expect([...extras].filter((name) => !optional.has(name))).toEqual([]);
	});

	test("the base install is the required peers plus this package's dependencies", () => {
		const optional = new Set(
			Object.entries(manifest.peerDependenciesMeta ?? {})
				.filter(([, meta]) => meta?.optional)
				.map(([name]) => name),
		);
		const required = Object.keys(manifest.peerDependencies ?? {}).filter(
			(name) => !optional.has(name),
		);
		expect([...baseInstall()].sort()).toEqual(
			[...required, ...Object.keys(manifest.dependencies ?? {})].sort(),
		);
	});
});

function baseInstall(): string[] {
	const optional = new Set(
		Object.entries(manifest.peerDependenciesMeta ?? {})
			.filter(([, meta]) => meta?.optional)
			.map(([name]) => name),
	);
	return [
		...Object.keys(manifest.peerDependencies ?? {}).filter(
			(name) => !optional.has(name),
		),
		...Object.keys(manifest.dependencies ?? {}),
	];
}

/**
 * Builds a node_modules tree containing the packed tarball plus *only* the
 * named packages.
 *
 * The tarball is extracted, not linked, so what is under test is what would
 * ship. Its dependencies are symlinked from the workspace because the gate runs
 * offline and cannot `npm install` them — the isolation property that matters
 * is which packages are present, and that is fully controlled here. Symlinked
 * packages still resolve *their own* dependencies via realpath, exactly as a
 * real install gives them.
 */
async function buildFixture(name: string, allowed: string[]) {
	const root = join(scratch, `fixture-${name}`);
	const modules = join(root, "node_modules");
	await mkdir(modules, { recursive: true });
	await writeFile(
		join(root, "package.json"),
		JSON.stringify({ name: `fixture-${name}`, private: true, type: "module" }),
	);

	for (const dep of allowed) {
		const source = join(REPO, "node_modules", dep);
		if (!existsSync(source)) continue; // optional peer not installed here
		const target = join(modules, dep);
		await mkdir(dirname(target), { recursive: true });
		await symlink(source, target, "dir");
	}

	const installed = join(modules, PKG_NAME);
	await mkdir(dirname(installed), { recursive: true });
	run("cp", ["-R", packageRoot, installed], scratch);
	return root;
}

/** Imports specifiers under Node's ESM resolver, from inside `root`. */
async function nodeImport(root: string, specifiers: string[]) {
	const script = join(root, "probe.mjs");
	await writeFile(
		script,
		specifiers
			.map(
				(s) => `await import(${JSON.stringify(s)});\nconsole.log("ok ${s}");`,
			)
			.join("\n"),
	);
	return spawnSync(nodeBinary, [script], {
		cwd: root,
		encoding: "utf8",
		env: { ...process.env, NODE_OPTIONS: "" },
	});
}

/**
 * Type-checks a consumer file that imports `specifiers`, and returns only the
 * diagnostics attributable to *this package's* shipped declarations or to the
 * consumer file itself.
 *
 * Uses the compiler API rather than spawning `tsc` so diagnostics carry a real
 * file path. That matters: `skipLibCheck` has to stay off for an unresolvable
 * type import in a shipped `.d.ts` to be reported at all, which also surfaces
 * unrelated conflicts inside third-party declarations (`@neondatabase/serverless`
 * against the ambient Node types, for one). Those are not this package's
 * artifact and filtering them by path is exact, where filtering printed text
 * would be guesswork.
 */
async function consumerCompile(root: string, specifiers: string[]) {
	const consumer = join(root, "consumer.ts");
	await writeFile(
		consumer,
		`${specifiers
			.map((s, i) => `import * as m${i} from ${JSON.stringify(s)};`)
			.join("\n")}\nexport const surface = [${specifiers
			.map((_, i) => `m${i}`)
			.join(", ")}];\n`,
	);

	const program = ts.createProgram([consumer], {
		noEmit: true,
		strict: true,
		target: ts.ScriptTarget.ESNext,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		skipLibCheck: false,
		types: [],
		lib: ["lib.esnext.d.ts", "lib.dom.d.ts"],
	});

	// macOS `os.tmpdir()` is `/var/...`, a symlink to `/private/var/...`, and
	// TypeScript reports realpaths. Comparing the two directly silently matches
	// nothing, which would filter away every diagnostic and make this check
	// pass vacuously.
	const realRoot = realpathSync(root);
	const ours = join(realRoot, "node_modules", PKG_NAME);
	const realConsumer = realpathSync(consumer);
	return [
		...program.getSyntacticDiagnostics(),
		...program.getSemanticDiagnostics(),
	]
		.filter((d) => {
			const file = d.file?.fileName;
			if (!file) return false;
			return file === realConsumer || file.startsWith(ours);
		})
		.map(
			(d) =>
				`${d.file?.fileName.replace(realRoot, "<fixture>")}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`,
		);
}

describe("per-entry-point strict install fixtures", () => {
	// Group entry points by their install set so the (slow) consumer compile
	// runs once per distinct set rather than once per entry point.
	const groups = new Map<string, { extras: string[]; entries: string[] }>();
	for (const [subpath, extras] of Object.entries(ENTRY_EXTRAS)) {
		const key = [...extras].sort().join("+") || "base";
		const group = groups.get(key) ?? { extras, entries: [] };
		group.entries.push(
			subpath === "." ? PKG_NAME : `${PKG_NAME}${subpath.slice(1)}`,
		);
		groups.set(key, group);
	}

	for (const [key, { extras, entries }] of groups) {
		test(`[${key}] imports under Node with only the documented install`, async () => {
			const root = await buildFixture(`node-${key}`, [
				...baseInstall(),
				...extras,
			]);
			const result = await nodeImport(root, entries);
			if (result.status !== 0) {
				throw new Error(
					`import failed with install set {${[...baseInstall(), ...extras].join(", ")}}:\n${result.stdout}\n${result.stderr}`,
				);
			}
			for (const entry of entries) {
				expect(result.stdout).toContain(`ok ${entry}`);
			}
		});

		test(`[${key}] typechecks for a consumer with only the documented install`, async () => {
			const root = await buildFixture(`tsc-${key}`, [
				...baseInstall(),
				...extras,
			]);
			expect(await consumerCompile(root, entries)).toEqual([]);
		});
	}
});

describe("the fixtures are genuinely strict", () => {
	// Negative control for runtime resolution. `@better-auth/utils` is present
	// in the workspace and used to be imported by `/provider`.
	test("an undeclared package is unreachable", async () => {
		const root = await buildFixture("undeclared", baseInstall());
		const result = await nodeImport(root, ["@better-auth/utils/base64"]);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toMatch(MODULE_NOT_FOUND);
	});

	// Regression control for the reason `zod` became a required peer: `/server`
	// has a runtime `zod` import, so a consumer told to install only
	// `better-auth` would have hit ERR_MODULE_NOT_FOUND.
	test("dropping zod breaks /server, proving it is genuinely required", async () => {
		const withoutZod = baseInstall().filter((name) => name !== "zod");
		expect(withoutZod).not.toContain("zod");

		const root = await buildFixture("no-zod", withoutZod);
		const result = await nodeImport(root, [`${PKG_NAME}/server`]);

		expect(result.status).not.toBe(0);
		expect(result.stderr).toMatch(MODULE_NOT_FOUND);
		expect(result.stderr).toContain("zod");
	});

	// Negative control for the type-only class of bug, which no runtime import
	// can see: `@better-fetch/fetch` is erased at runtime but must resolve for
	// `./client`'s shipped declarations.
	test("dropping a type-only peer is caught by the consumer compile", async () => {
		const root = await buildFixture("no-better-fetch", baseInstall());
		const diagnostics = await consumerCompile(root, [`${PKG_NAME}/client`]);

		expect(diagnostics.join("\n")).toContain("@better-fetch/fetch");
	});
});
