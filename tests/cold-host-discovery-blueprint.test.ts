import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fauxAssistantMessage, fauxToolCall, uuidv7 } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { discoverColdWorkflow } from "../src/bootstrap/cold-host-discovery.ts";
import { commitAgentRuntimeBlueprint } from "../src/protocol/agent-runtime-blueprint.ts";
import { commitChildAgentIdentity } from "../src/protocol/child-identity.ts";
import type { OwnerIdentity } from "../src/protocol/owner-identity.ts";
import { workflowSessionDirectory } from "../src/runtime/workflow-session-directory.ts";

test("cold discovery admits only exact role/id/effective-cwd Runtime blueprints", async () => {
	const root = await mkdtemp(join(tmpdir(), "cold-blueprint-admission-"));
	const cwd = join(root, "work");
	const effectiveCwd = join(cwd, "effective");
	const ownerSessions = join(root, "owner-sessions");
	await Promise.all([
		mkdir(effectiveCwd, { recursive: true }),
		mkdir(ownerSessions, { recursive: true }),
	]);
	const ownerSession = SessionManager.create(cwd, ownerSessions, { id: uuidv7() });
	const ownerIdentity: OwnerIdentity = {
		agentId: ownerSession.getSessionId(),
		workflowId: ownerSession.getSessionId(),
		directSpawnerAgentId: null,
		configuration: {
			label: "owner",
			baseline: baseline(cwd),
		},
	};
	ownerSession.appendCustomEntry("agent-coordination.identity", ownerIdentity);
	const kinds = [
		"valid",
		"missing",
		"duplicate",
		"wrong-role",
		"wrong-agent-id",
		"wrong-header-cwd",
	] as const;
	const spawnEntryId = ownerSession.appendMessage(
		fauxAssistantMessage(
			kinds.map((kind) => fauxToolCall(
				"agent_spawn",
				{ request: `Create ${kind}.`, label: kind },
				{ id: `spawn-${kind}` },
			)),
			{ stopReason: "toolUse" },
		),
	);
	const directory = workflowSessionDirectory(
		ownerSession.getSessionDir(),
		ownerIdentity.workflowId,
	);
	await mkdir(directory, { recursive: true });
	const agentIdByKind = new Map<string, string>();
	for (const kind of kinds) {
		const id = uuidv7();
		agentIdByKind.set(kind, id);
		const staging = SessionManager.create(effectiveCwd, directory, { id });
		commitChildAgentIdentity(staging, {
			agentId: id,
			workflowId: ownerIdentity.workflowId,
			directSpawnerAgentId: ownerIdentity.agentId,
			spawnSource: {
				agentId: ownerIdentity.agentId,
				entryId: spawnEntryId,
				toolCallId: `spawn-${kind}`,
			},
			configuration: {
				label: kind,
				baseline: baseline(cwd),
			},
		});
		if (kind !== "missing") {
			commitAgentRuntimeBlueprint(staging, blueprint(
				id,
				kind === "wrong-role" ? "moderator" : "ordinary",
				kind === "wrong-header-cwd" ? cwd : effectiveCwd,
			));
		}
		if (kind === "duplicate") {
			staging.appendCustomEntry(
				"agent-coordination.runtime-blueprint",
				blueprint(id, "ordinary", effectiveCwd),
			);
		}
		const entries = staging.getEntries().map((entry) => {
			if (
				kind === "wrong-agent-id" &&
				entry.type === "custom" &&
				entry.customType === "agent-coordination.runtime-blueprint"
			) {
				return {
					...entry,
					data: { ...(entry.data as object), agentId: uuidv7() },
				};
			}
			return entry;
		});
		const header = staging.getHeader();
		const path = staging.getSessionFile();
		assert.ok(header && path);
		await writeFile(
			path,
			`${[header, ...entries].map((value) => JSON.stringify(value)).join("\n")}\n`,
			{ mode: 0o600 },
		);
	}

	const recovery = await discoverColdWorkflow({
		ownerIdentity,
		ownerSessionManager: ownerSession,
	});
	assert.deepEqual(recovery.agents.map(({ identity }) => identity.agentId), [
		agentIdByKind.get("valid"),
	]);
	assert.equal(recovery.quarantinedCandidateCount, kinds.length - 1);
	for (const kind of kinds.slice(1)) {
		assert.ok(recovery.quarantinedAgentIds.has(agentIdByKind.get(kind)!));
	}
	const recovered = recovery.agents[0];
	assert.ok(recovered);
	assert.deepEqual(Object.keys(recovered).sort(), [
		"blueprint",
		"identity",
		"role",
		"sessionPath",
	]);
	assert.equal(recovered.blueprint.configuration.cwd, effectiveCwd);
	assert.equal(recovered.sessionPath, recovery.transcriptPathByAgentId.get(recovered.identity.agentId));
});

function baseline(cwd: string) {
	return {
		cwd,
		model: { provider: "test", modelId: "model" },
		thinking: "off" as const,
		tools: [],
		skills: [],
		extensions: [],
	};
}

function blueprint(
	agentId: string,
	role: "ordinary" | "moderator",
	cwd: string,
) {
	return {
		agentId,
		role,
		configuration: {
			...baseline(cwd),
			tools: role === "ordinary"
				? ["agent_message", "agent_control", "agent_observe", "agent_spawn", "ask_user_question"]
				: ["agent_message", "agent_control", "agent_observe", "ask_user_question", "moderator_control"],
		},
		projectTrusted: true,
		skillSources: [],
		agentsFiles: [],
	};
}
