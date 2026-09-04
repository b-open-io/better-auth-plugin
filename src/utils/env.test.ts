import { afterEach, describe, expect, test } from "bun:test";
import {
	resetAccountPrivateKeyWarning,
	resolveAccountPrivateKey,
} from "./env.js";

const NEW_KEY = "SIGMA_ACCOUNT_PRIVATE_KEY";
const OLD_KEY = "SIGMA_MEMBER_PRIVATE_KEY";

afterEach(() => {
	delete process.env[NEW_KEY];
	delete process.env[OLD_KEY];
	resetAccountPrivateKeyWarning();
});

describe("resolveAccountPrivateKey", () => {
	test("explicit config wins over everything", () => {
		process.env[NEW_KEY] = "env-key";
		process.env[OLD_KEY] = "legacy-key";
		expect(resolveAccountPrivateKey("config-key")).toBe("config-key");
	});

	test("prefers the new variable over the legacy one", () => {
		process.env[NEW_KEY] = "env-key";
		process.env[OLD_KEY] = "legacy-key";
		expect(resolveAccountPrivateKey()).toBe("env-key");
	});

	test("falls back to the legacy variable", () => {
		process.env[OLD_KEY] = "legacy-key";
		expect(resolveAccountPrivateKey()).toBe("legacy-key");
	});

	test("returns undefined when neither is set", () => {
		expect(resolveAccountPrivateKey()).toBeUndefined();
	});
});
