/**
 * Coverage for the `organizations.ensureOnEnrollment` gate.
 *
 * The provider used to write the `organization` and `member` rows itself on
 * every enrollment. A consuming app that gives `organization.id` a foreign key
 * onto a row it writes later in the same flow (sigma-auth) needs that write to
 * be its own, so the gate has to be provably total: with it off the adapter
 * must see *no* write at all, not merely a different one.
 */

import { describe, expect, test } from "bun:test";

import {
	type BapOrganizationAdapter,
	ensureBapOrganizationOnEnrollment,
} from "./index.js";

interface CreateCall {
	model: string;
	data: Record<string, unknown>;
}

/**
 * In-memory adapter that records every call, so a test can assert on the
 * absence of a write rather than only on its shape.
 */
function createFakeAdapter(seed: Record<string, unknown>[] = []) {
	const rows = seed.map((row) => ({ ...row }));
	const findOneCalls: { model: string }[] = [];
	const createCalls: CreateCall[] = [];

	const adapter: BapOrganizationAdapter = {
		async findOne<T>(opts: {
			model: string;
			where: { field: string; value: string }[];
		}): Promise<T | null> {
			findOneCalls.push({ model: opts.model });
			const found = rows.find(
				(row) =>
					row.__model === opts.model &&
					opts.where.every((clause) => row[clause.field] === clause.value),
			);
			return (found ?? null) as T | null;
		},
		async create(opts: { model: string; data: Record<string, unknown> }) {
			createCalls.push({ model: opts.model, data: opts.data });
			rows.push({ __model: opts.model, ...opts.data });
			return opts.data;
		},
	};

	return { adapter, findOneCalls, createCalls };
}

function createRecordingDebug() {
	const lines: string[] = [];
	return {
		lines,
		debug: {
			log: (message: string) => {
				lines.push(message);
			},
			warn: (message: string) => {
				lines.push(message);
			},
			error: (message: string) => {
				lines.push(message);
			},
		},
	};
}

const BAP_ID = "bap_1234567890abcdef1234567890abcdef";
const USER_ID = "user_1";

describe("ensureBapOrganizationOnEnrollment", () => {
	test("creates the organization and member rows by default", async () => {
		const { adapter, createCalls } = createFakeAdapter();
		const { debug } = createRecordingDebug();

		await ensureBapOrganizationOnEnrollment(
			undefined,
			adapter,
			debug,
			BAP_ID,
			USER_ID,
			"Alice",
		);

		expect(createCalls.map((call) => call.model)).toEqual([
			"organization",
			"member",
		]);
		expect(createCalls[0]?.data).toMatchObject({
			id: BAP_ID,
			name: "Alice",
			slug: BAP_ID,
		});
		expect(createCalls[1]?.data).toMatchObject({
			organizationId: BAP_ID,
			userId: USER_ID,
			role: "owner",
		});
	});

	test("creates both rows when the option is explicitly enabled", async () => {
		const { adapter, createCalls } = createFakeAdapter();
		const { debug } = createRecordingDebug();

		await ensureBapOrganizationOnEnrollment(
			{ ensureOnEnrollment: true },
			adapter,
			debug,
			BAP_ID,
			USER_ID,
			null,
		);

		expect(createCalls.map((call) => call.model)).toEqual([
			"organization",
			"member",
		]);
	});

	test("writes nothing when ensureOnEnrollment is false", async () => {
		const { adapter, createCalls, findOneCalls } = createFakeAdapter();
		const { debug, lines } = createRecordingDebug();

		await ensureBapOrganizationOnEnrollment(
			{ ensureOnEnrollment: false },
			adapter,
			debug,
			BAP_ID,
			USER_ID,
			"Alice",
		);

		// Neither the organization nor the member row is written, and the
		// existence probe is skipped too — the application owns the whole write.
		expect(createCalls).toEqual([]);
		expect(findOneCalls).toEqual([]);
		expect(lines).toEqual([
			"organization creation delegated to the application",
		]);
	});
});
