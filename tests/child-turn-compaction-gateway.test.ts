import assert from "node:assert/strict";
import test from "node:test";

import type { AgentSession } from "@earendil-works/pi-coding-agent";

import { ChildTurnCompactionGateway } from "../src/process-runtime/child-turn-compaction-gateway.ts";
import type { WorkingZonePreparation } from "../src/runtime/agent-runtime-host.ts";

const preparation: WorkingZonePreparation = {
	intent: { workScale: "large", contextDependence: "low" },
	prospectiveRequest: {
		kind: "request",
		requestMessageId: "prepared-request",
		fromAgentId: "requester-agent",
		question: "Use the acquired parser context and compare x < y & y > z.",
	},
};

function fakeSession(options: {
	tokens: number | null;
	autoCompactionEnabled?: boolean;
	settingsEnabled?: boolean;
	compactError?: Error;
}) {
	const compactInstructions: Array<string | undefined> = [];
	const session = {
		isCompacting: false,
		isIdle: true,
		autoCompactionEnabled: options.autoCompactionEnabled ?? true,
		thinkingLevel: "high",
		getContextUsage: () => ({
			tokens: options.tokens,
			contextWindow: 200_000,
			percent: options.tokens === null ? null : options.tokens / 2_000,
		}),
		settingsManager: {
			getCompactionSettings: () => ({
				enabled: options.settingsEnabled ?? true,
				reserveTokens: 16_000,
				keepRecentTokens: 20_000,
			}),
		},
		compact: async (customInstructions?: string) => {
			compactInstructions.push(customInstructions);
			if (options.compactError) throw options.compactError;
			return {
				summary: "prepared",
				firstKeptEntryId: "entry",
				tokensBefore: options.tokens ?? 0,
			};
		},
	} as unknown as AgentSession;
	return { session, compactInstructions };
}

test("each working-zone admission calls the active strategy once with prospective relevance guidance", async () => {
	const { session, compactInstructions } = fakeSession({ tokens: 100_000 });
	const warnings: string[] = [];
	const gateway = new ChildTurnCompactionGateway(session, (warning) => warnings.push(warning));

	await gateway.prepareIdleCustomTurn(preparation);

	assert.equal(compactInstructions.length, 1);
	assert.match(
		compactInstructions[0] ?? "",
		/<prospective_request>\nUse the acquired parser context and compare x &lt; y &amp; y &gt; z\.\n<\/prospective_request>/,
	);
	assert.match(compactInstructions[0] ?? "", /has not committed to this transcript/);
	assert.match(compactInstructions[0] ?? "", /Do not include or paraphrase it/);
	assert.deepEqual(warnings, []);

	await gateway.prepareIdleCustomTurn(preparation);
	assert.equal(compactInstructions.length, 2);
});

test("working-zone preparation skips disabled automatic compaction and unknown usage", async () => {
	for (const options of [
		{ tokens: 100_000, autoCompactionEnabled: false },
		{ tokens: 100_000, settingsEnabled: false },
		{ tokens: null },
	] as const) {
		const { session, compactInstructions } = fakeSession(options);
		const gateway = new ChildTurnCompactionGateway(session);
		await gateway.prepareIdleCustomTurn(preparation);
		assert.deepEqual(compactInstructions, []);
	}
});

test("optional below-native failure warns and continues without another attempt", async () => {
	const { session, compactInstructions } = fakeSession({
		tokens: 100_000,
		compactError: new Error("optional strategy failed"),
	});
	const warnings: string[] = [];
	const gateway = new ChildTurnCompactionGateway(session, (warning) => warnings.push(warning));

	await gateway.prepareIdleCustomTurn(preparation);

	assert.equal(compactInstructions.length, 1);
	assert.deepEqual(warnings, [
		"Working-Zone Preparation failed; continuing Request Delivery: optional strategy failed",
	]);
});

test("no compaction work at Pi's native threshold keeps existing no-op behavior", async () => {
	for (const message of ["Nothing to compact (session too small)", "Already compacted"]) {
		const { session, compactInstructions } = fakeSession({
			tokens: 190_000,
			compactError: new Error(message),
		});
		const gateway = new ChildTurnCompactionGateway(session);
		await gateway.prepareIdleCustomTurn(preparation);
		assert.equal(compactInstructions.length, 1);
	}
});

test("Runtime-generation disposal fences a prepared admission after compaction returns", async () => {
	const { session, compactInstructions } = fakeSession({ tokens: 100_000 });
	let finishCompaction!: () => void;
	(session as unknown as { compact(customInstructions?: string): Promise<unknown> }).compact =
		(customInstructions?: string) => {
			compactInstructions.push(customInstructions);
			return new Promise<void>((resolve) => {
				finishCompaction = resolve;
			});
		};
	const gateway = new ChildTurnCompactionGateway(session);
	const admission = gateway.admitOwnerTurn("prepared-run", () =>
		gateway.prepareIdleCustomTurn(preparation)
	);
	while (compactInstructions.length === 0) await new Promise((resolve) => setImmediate(resolve));
	gateway.dispose();
	finishCompaction();
	await assert.rejects(admission, /child_turn_compaction_gateway_disposed/);
});

test("failure at Pi's native threshold remains blocking", async () => {
	const { session, compactInstructions } = fakeSession({
		tokens: 190_000,
		compactError: new Error("native threshold strategy failed"),
	});
	const gateway = new ChildTurnCompactionGateway(session);

	await assert.rejects(
		gateway.prepareIdleCustomTurn(preparation),
		/native threshold strategy failed/,
	);
	assert.equal(compactInstructions.length, 1);
});
