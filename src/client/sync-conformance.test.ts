import { afterEach, describe, expect, test } from "bun:test";
import { Hash, HD, KeyDeriver, Mnemonic, PrivateKey, Utils } from "@bsv/sdk";
import { parseAuthToken, verifyAuthToken } from "bitcoin-auth";
import type { BAP } from "bsv-bap";
import { pullBackup, pushBackup } from "./sync.js";

// Public BRC-157 test vector. Only the selected account accessor is passed to sync.
const words =
	"legal winner thank year wave sausage worth useful legal winner thank yellow";
const hd = HD.fromSeed(Mnemonic.fromString(words).toSeed());
const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});
function idFor(key: PrivateKey) {
	const address = new KeyDeriver(key)
		.derivePublicKey([1, "sigma"], "identity-0", "self", true)
		.toAddress();
	return Utils.toBase58(Hash.ripemd160(Hash.sha256(address, "utf8")));
}
function fakeBap(id: string, identity: object): BAP {
	return {
		getId: (selected: string) => (selected === id ? identity : null),
	} as unknown as BAP;
}
function intercept() {
	const calls: { url: string; init?: RequestInit }[] = [];
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		calls.push({ url: String(input), init });
		return new Response(
			JSON.stringify({
				encryptedBackup: "opaque-encrypted-envelope",
				lastUpdated: "timestamp",
			}),
			{ status: 200 },
		);
	}) as typeof fetch;
	return calls;
}
function tokenFrom(init?: RequestInit) {
	const header = new Headers(init?.headers).get("Authorization");
	if (!header) throw new Error("Missing authorization token");
	const token = header.replace("Bitcoin-Auth ", "");
	const parsed = parseAuthToken(token);
	if (!parsed) throw new Error("Invalid authorization token");
	return { token, parsed };
}
describe("selected account backup sync conformance", () => {
	test("peer profile signs with its account root and transports only ID plus opaque ciphertext", async () => {
		const key = hd.derive("m/0'/1'").privKey;
		const bapId = idFor(key);
		expect(bapId).toBe("3DZe4cir2TXsvdoNig54ZjycBpHR");
		const bap = fakeBap(bapId, {
			rootPath: "m/0'/1'",
			getAccountKey: () => key,
		});
		const calls = intercept();
		expect(
			await pushBackup(bap, bapId, "opaque-encrypted-envelope", {
				serverUrl: "https://example.invalid",
			}),
		).toEqual({ success: true });
		const first = calls[0];
		if (!first) throw new Error("Missing push request");
		const body = String(first.init?.body);
		expect(JSON.parse(body)).toEqual({
			bapId,
			encryptedBackup: "opaque-encrypted-envelope",
		});
		const { token, parsed } = tokenFrom(first.init);
		expect(parsed.pubkey).toBe(key.toPublicKey().toString());
		expect(
			verifyAuthToken(token, {
				requestPath: "/api/backup/sync",
				timestamp: parsed.timestamp,
				body,
			}),
		).toBe(true);
		const wire = JSON.stringify(calls);
		for (const secret of [
			words,
			hd.toString(),
			hd.derive("m/0'/0'").privKey.toWif(),
			key.toWif(),
		])
			expect(wire).not.toContain(secret);
		expect(Object.keys(JSON.parse(body)).sort()).toEqual([
			"bapId",
			"encryptedBackup",
		]);
	});
	test("stable account getter takes precedence over deprecated derivation accessors", async () => {
		const key = PrivateKey.fromHex("01");
		const bapId = idFor(key);
		const calls = intercept();
		const bap = fakeBap(bapId, {
			rootPath: "ignored",
			getAccountKey: () => key,
			getWalletRoot: () => {
				throw new Error("deprecated getter used");
			},
		});
		expect(
			(
				await pushBackup(bap, bapId, "cipher", {
					serverUrl: "https://example.invalid",
				})
			).success,
		).toBe(true);
		expect(calls).toHaveLength(1);
	});
	test("legacy HD and Type42 wallet/path getters retain their exact stable key", async () => {
		for (const [name, key, rootPath] of [
			[
				"getWalletRoot",
				hd.derive("m/424150'/0'/0'/0/0/0").privKey,
				"m/424150'/0'/0'/0/0/0",
			],
			[
				"getPathDerivedKey",
				PrivateKey.fromHex("02").deriveChild(
					PrivateKey.fromHex("02").toPublicKey(),
					"bap:3",
				),
				"bap:3",
			],
		] as const) {
			const bapId = idFor(key);
			const calls = intercept();
			const bap = fakeBap(bapId, {
				rootPath,
				[name]: (path: string) => {
					expect(path).toBe(rootPath);
					return key;
				},
			});
			expect(
				(await pullBackup(bap, bapId, { serverUrl: "https://example.invalid" }))
					.encryptedBackup,
			).toBe("opaque-encrypted-envelope");
			const first = calls[0];
			if (!first) throw new Error("Missing pull request");
			const { token, parsed } = tokenFrom(first.init);
			expect(parsed.pubkey).toBe(key.toPublicKey().toString());
			expect(
				verifyAuthToken(token, {
					requestPath: "/api/backup/sync",
					timestamp: parsed.timestamp,
				}),
			).toBe(true);
		}
	});
	test("missing identity or stable accessor fails before a request", async () => {
		const calls = intercept();
		for (const bap of [
			fakeBap("other", {}),
			fakeBap("selected", { rootPath: "bap:0" }),
		]) {
			expect(
				(
					await pushBackup(bap, "selected", "cipher", {
						serverUrl: "https://example.invalid",
					})
				).success,
			).toBe(false);
		}
		expect(calls).toHaveLength(0);
	});
});
