import assert from "node:assert/strict";
import test from "node:test";

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	InputEvent,
} from "@earendil-works/pi-coding-agent";

import sdkAgentSupervisorInProcess, { createSessionExtension } from "./owner-extension.ts";
import type { InProcessSupervisorCoordinator } from "./supervisor-coordinator.ts";

test("plain Pi extension registers /agents as the switching interface", () => {
	const commands = new Map<string, unknown>();
	const extensionApi = {
		registerCommand(name: string, command: unknown) {
			commands.set(name, command);
		},
		on() {},
	} as unknown as ExtensionAPI;

	sdkAgentSupervisorInProcess(extensionApi);

	assert.equal(commands.has("agents"), true);
});

test("selected child editor consumes only a pending Human Answer", async () => {
	const commands = new Map<string, { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }>();
	let inputHandler:
		| ((event: InputEvent, ctx: ExtensionCommandContext) => Promise<{ action: string }>)
		| undefined;
	const answered: string[] = [];
	let pending = false;
	const coordinator = {
		requestHumanAnswer: async () => "Use the native transcript.",
		pendingHumanRequest: () => (pending ? { prompt: "Which implementation?" } : undefined),
		answerHumanRequest: (_key: string, answer: string) => {
			answered.push(answer);
			pending = false;
			return true;
		},
	} as unknown as InProcessSupervisorCoordinator;
	const extensionApi = {
		registerCommand(name: string, command: { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }) {
			commands.set(name, command);
		},
		on(eventType: string, handler: typeof inputHandler) {
			if (eventType === "input") inputHandler = handler;
		},
	} as unknown as ExtensionAPI;
	createSessionExtension("researcher", async () => coordinator)(extensionApi);
	const ctx = { ui: { notify() {} } } as unknown as ExtensionCommandContext;

	assert.equal(commands.has("prototype-human-request"), true);
	assert.ok(inputHandler);
	assert.deepEqual(
		await inputHandler(
			{ type: "input", text: "ordinary prompt", source: "interactive" },
			ctx,
		),
		{ action: "continue" },
	);

	pending = true;
	assert.deepEqual(
		await inputHandler(
			{ type: "input", text: "Use Pi's native transcript.", source: "interactive" },
			ctx,
		),
		{ action: "handled" },
	);
	assert.deepEqual(answered, ["Use Pi's native transcript."]);
});
