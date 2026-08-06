import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

import { OperationalIncidentSurface } from "../src/presentation/operational-incident-surface.ts";

test("exhausted handling is presented passively with bounded diagnostic evidence", () => {
	const statuses: Array<string | undefined> = [];
	const widgets: Array<readonly string[] | undefined> = [];
	const ui = {
		setStatus(_key: string, value: string | undefined) {
			statuses.push(value);
		},
		setWidget(_key: string, value: readonly string[] | undefined) {
			widgets.push(value);
		},
	} as unknown as ExtensionUIContext;
	const surface = new OperationalIncidentSurface(ui);
	const attention = {
		trigger: {
			kind: "dependency_deadlock" as const,
			agentIds: ["agent-alpha", "agent-bravo"],
			requests: {
				total: 2,
				sources: [
					{ agentId: "agent-alpha", entryId: "request-a", toolCallId: "call-a" },
					{ agentId: "agent-bravo", entryId: "request-b", toolCallId: "call-b" },
				],
			},
		},
		affectedAgentIds: ["agent-alpha", "agent-bravo"],
		diagnostics: [
			{ agentId: "moderator-first", entryId: "terminal-first" },
			{ agentId: "moderator-second", entryId: "terminal-second" },
		],
	};

	surface.present("condition-key", attention);
	assert.equal(statuses.at(-1), "1 Operational Incident · ATTENTION");
	assert.deepEqual(widgets.at(-1), [
		"Operational Attention · 1",
		"  Dependency Deadlock · agent-alpha, agent-bravo",
		"    Requests · 2",
		"      Request · agent-alpha · request-a · call-a",
		"      Request · agent-bravo · request-b · call-b",
		"    Diagnostic · moderator-first · terminal-first",
		"    Diagnostic · moderator-second · terminal-second",
	]);
	assert.deepEqual(surface.items(), [attention]);

	surface.dismiss("condition-key");
	assert.equal(statuses.at(-1), undefined);
	assert.equal(widgets.at(-1), undefined);

	surface.present("run-failure", {
		trigger: {
			kind: "run_failure",
			agentId: "agent-charlie",
			runSequence: 7,
			obligations: {
				total: 1,
				sources: [{
					agentId: "agent-delta",
					entryId: "request-c",
					toolCallId: "call-c",
				}],
			},
		},
		affectedAgentIds: ["agent-charlie"],
		diagnostics: [{ agentId: "moderator-third", entryId: "terminal-third" }],
	});
	assert.deepEqual(widgets.at(-1), [
		"Operational Attention · 1",
		"  Run Failure · agent-charlie · Run 7",
		"    Requests · 1",
		"      Request · agent-delta · request-c · call-c",
		"    Diagnostic · moderator-third · terminal-third",
	]);
});
