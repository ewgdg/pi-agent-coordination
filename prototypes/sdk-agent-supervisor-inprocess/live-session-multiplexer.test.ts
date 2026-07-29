import assert from "node:assert/strict";
import test from "node:test";

import {
	AgentSessionRuntime,
	type AgentSession,
	type AgentSessionServices,
} from "@earendil-works/pi-coding-agent";

import { LiveSessionMultiplexer } from "./live-session-multiplexer.ts";
import {
	bindPiRuntimeSelection,
	bindPiRuntimeShutdown,
} from "./pi-runtime-selection.ts";

type DisposableSession = AgentSession & {
	disposeCalls: number;
	lifecycleEvents: string[];
};

function fakeSession(): DisposableSession {
	const lifecycleEvents: string[] = [];
	return {
		disposeCalls: 0,
		lifecycleEvents,
		extensionRunner: {
			hasHandlers: (eventType: string) => eventType === "session_shutdown",
			emit(event: { type: string; reason: string }) {
				lifecycleEvents.push(`${event.type}:${event.reason}`);
			},
		},
		dispose(this: DisposableSession) {
			this.disposeCalls += 1;
			this.lifecycleEvents.push("dispose");
		},
	} as unknown as DisposableSession;
}

function fakeServices(name: string): AgentSessionServices {
	return { cwd: `/project/${name}` } as AgentSessionServices;
}

function runtimeFor(session: AgentSession, services: AgentSessionServices): AgentSessionRuntime {
	return new AgentSessionRuntime(session, services, async () => {
		throw new Error("session replacement is outside this test");
	});
}

test("selection rebinds native Pi state without disposing retained sessions", async () => {
	const ownerSession = fakeSession();
	const researcherSession = fakeSession();
	const ownerServices = fakeServices("owner");
	const researcherServices = fakeServices("researcher");
	const runtime = runtimeFor(ownerSession, ownerServices);
	const presentedSessions: AgentSession[] = [];
	runtime.setBeforeSessionInvalidate(() => undefined);
	runtime.setRebindSession(async (selectedSession) => {
		presentedSessions.push(selectedSession);
	});

	const multiplexer = new LiveSessionMultiplexer(
		bindPiRuntimeSelection(runtime),
		{
			key: "owner",
			session: ownerSession,
			services: ownerServices,
			diagnostics: [],
		},
	);
	multiplexer.register({
		key: "researcher",
		session: researcherSession,
		services: researcherServices,
		diagnostics: [],
	});

	await multiplexer.select("researcher");
	assert.equal(runtime.session, researcherSession);
	assert.equal(runtime.services, researcherServices);
	assert.equal(multiplexer.selectedKey, "researcher");

	await multiplexer.select("owner");
	assert.equal(runtime.session, ownerSession);
	assert.equal(runtime.services, ownerServices);
	assert.equal(multiplexer.selectedKey, "owner");
	assert.deepEqual(presentedSessions, [researcherSession, ownerSession]);
	assert.equal(ownerSession.disposeCalls, 0);
	assert.equal(researcherSession.disposeCalls, 0);
});

test("Pi shutdown disposes the selected and retained sessions exactly once", async () => {
	const ownerSession = fakeSession();
	const researcherSession = fakeSession();
	const ownerServices = fakeServices("owner");
	const researcherServices = fakeServices("researcher");
	const runtime = runtimeFor(ownerSession, ownerServices);
	runtime.setBeforeSessionInvalidate(() => undefined);
	runtime.setRebindSession(async () => undefined);

	const multiplexer = new LiveSessionMultiplexer(
		bindPiRuntimeSelection(runtime),
		{
			key: "owner",
			session: ownerSession,
			services: ownerServices,
			diagnostics: [],
		},
	);
	multiplexer.register({
		key: "researcher",
		session: researcherSession,
		services: researcherServices,
		diagnostics: [],
	});
	bindPiRuntimeShutdown(runtime, multiplexer);

	await multiplexer.select("researcher");
	await runtime.dispose();
	await runtime.dispose();

	assert.equal(ownerSession.disposeCalls, 1);
	assert.equal(researcherSession.disposeCalls, 1);
	assert.deepEqual(ownerSession.lifecycleEvents, ["session_shutdown:quit", "dispose"]);
	assert.deepEqual(researcherSession.lifecycleEvents, ["session_shutdown:quit", "dispose"]);
});
