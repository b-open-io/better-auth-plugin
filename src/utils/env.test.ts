import { afterEach, describe, expect, test } from "bun:test";
import { resolveAccountPrivateKey } from "./env.js";

const NEW_KEY = "SIGMA_ACCOUNT_PRIVATE_KEY";
const OLD_KEY = "SIGMA_MEMBER_PRIVATE_KEY";

afterEach(() => {
	delete process.env[NEW_KEY];
	delete process.env[OLD_KEY];
});

describe("resolveAccountPrivateKey", () => {
	test("explicit config wins over everything", () => {
		process.env[NEW_KEY] = "env-key";
		process.env[OLD_KEY] = "legacy-key";
		expect(resolveAccountPrivateKey("config-key")).toBe("config-key");
	});

	test("reads the canonical variable", () => {
		process.env[NEW_KEY] = "env-key";
		expect(resolveAccountPrivateKey()).toBe("env-key");
	});

	test("ignores the legacy variable", () => {
		process.env[OLD_KEY] = "legacy-key";
		expect(resolveAccountPrivateKey()).toBeUndefined();
	});

	test("returns undefined when neither is set", () => {
		expect(resolveAccountPrivateKey()).toBeUndefined();
	});
});
