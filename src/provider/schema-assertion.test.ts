import { describe, expect, test } from "bun:test";
import type { Pool } from "@neondatabase/serverless";
import {
	assertProfileSchema,
	resetProfileSchemaVerification,
} from "./index.js";

const FULL_COLUMNS = [
	"user_id",
	"bap_id",
	"name",
	"image",
	"account_pubkey",
	"is_primary",
	"extra_unrelated_column",
];

function stubPool(columns: string[], calls: string[]): Pool {
	return {
		query: (sql: string) => {
			calls.push(sql);
			return Promise.resolve({
				rows: columns.map((column_name) => ({ column_name })),
			});
		},
	} as unknown as Pool;
}

describe("assertProfileSchema", () => {
	test("passes when every required profile column exists", async () => {
		resetProfileSchemaVerification();
		const calls: string[] = [];
		await assertProfileSchema(stubPool(FULL_COLUMNS, calls));
		expect(calls.length).toBeGreaterThan(0);
		expect(calls[0]).toContain("information_schema.columns");
	});

	test("fails closed naming the missing columns", async () => {
		resetProfileSchemaVerification();
		const calls: string[] = [];
		const missing = FULL_COLUMNS.filter(
			(column) => column !== "account_pubkey",
		);
		const error = await assertProfileSchema(stubPool(missing, calls)).then(
			() => null,
			(error: unknown) => error,
		);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("account_pubkey");
		expect((error as Error).message).toContain("migrate");
	});
});
