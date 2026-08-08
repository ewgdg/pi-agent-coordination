import assert from "node:assert/strict";
import test from "node:test";

import {
	SessionManager,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

import type { PiNativeAgentProjection } from "../src/pi-integration/native-agent-projection.ts";
import { InProcessAgentHost } from "../src/runtime/in-process-agent-host.ts";

test("clean release disposes the exact projection and session once", async () => {
	const resource = createRunResource();
	const host = InProcessAgentHost.createChild({
		sessionManager: SessionManager.inMemory(),
		startSession: async () => resource.startedRun,
	});
	const session = await host.lane.run(() => host.startInLane());
	const handle = host.currentHandle();
	assert.ok(handle);
	assert.equal(session, resource.session);

	assert.equal(
		await host.lane.run(() => host.releaseIfEligibleInLane(handle)),
		"released",
	);
	assert.deepEqual(resource.counts(), {
		projectionDisposals: 1,
		sessionDisposals: 1,
		unsubscriptions: 1,
	});
	assert.equal(host.observe().phase, "dormant");
});

test("failure, termination, and Workflow shutdown each dispose their exact projection and session once", async () => {
	for (const cause of ["failure", "termination", "shutdown"] as const) {
		const resource = createRunResource();
		const host = InProcessAgentHost.createChild({
			sessionManager: SessionManager.inMemory(),
			startSession: async () => resource.startedRun,
		});
		await host.lane.run(() => host.startInLane(["pending_delivery"]));

		await host.lane.run(() => host.discardAndEndInLane(cause));
		assert.deepEqual(
			resource.counts(),
			{
				projectionDisposals: 1,
				sessionDisposals: 1,
				unsubscriptions: 1,
			},
			cause,
		);
		assert.equal(host.observe().phase, "dormant", cause);
	}
});

test("failed startup after Run binding rolls back the projection and session once", async () => {
	const resource = createRunResource();
	const host = InProcessAgentHost.createChild({
		sessionManager: SessionManager.inMemory(),
		startSession: async () => resource.startedRun,
	});
	host.setRunStartedHandler(() => {
		throw new Error("confirmed post-projection startup failure");
	});

	await assert.rejects(
		() => host.lane.run(() => host.startInLane()),
		/confirmed post-projection startup failure/,
	);
	assert.deepEqual(resource.counts(), {
		projectionDisposals: 1,
		sessionDisposals: 1,
		unsubscriptions: 1,
	});
	assert.equal(host.observe().phase, "dormant");
});

test("native subscription failure rolls back the already-created projection and session", async () => {
	const resource = createRunResource({
		subscribeError: new Error("native subscription unavailable"),
	});
	const host = InProcessAgentHost.createChild({
		sessionManager: SessionManager.inMemory(),
		startSession: async () => resource.startedRun,
	});

	await assert.rejects(
		() => host.lane.run(() => host.startInLane()),
		/native subscription unavailable/,
	);
	assert.deepEqual(resource.counts(), {
		projectionDisposals: 1,
		sessionDisposals: 1,
		unsubscriptions: 0,
	});
	assert.equal(host.observe().phase, "dormant");
});

test("cleanup continues through projection failure and still disposes the exact session", async () => {
	const resource = createRunResource({
		projectionDisposeError: new Error("projection cleanup failed"),
	});
	const host = InProcessAgentHost.createChild({
		sessionManager: SessionManager.inMemory(),
		startSession: async () => resource.startedRun,
	});
	await host.lane.run(() => host.startInLane());

	await assert.rejects(
		() => host.lane.run(() => host.discardAndEndInLane("shutdown")),
		(error: unknown) =>
			error instanceof AggregateError &&
			error.errors.some((nested) =>
				nested instanceof Error && nested.message === "projection cleanup failed"
			),
	);
	assert.deepEqual(resource.counts(), {
		projectionDisposals: 1,
		sessionDisposals: 1,
		unsubscriptions: 1,
	});
	assert.equal(host.observe().phase, "dormant");
});

function createRunResource(options?: {
	projectionDisposeError?: Error;
	subscribeError?: Error;
}): {
	startedRun: Readonly<{ session: AgentSession; projection: PiNativeAgentProjection }>;
	session: AgentSession;
	counts(): Readonly<{
		projectionDisposals: number;
		sessionDisposals: number;
		unsubscriptions: number;
	}>;
} {
	let projectionDisposals = 0;
	let sessionDisposals = 0;
	let unsubscriptions = 0;
	const component: Component = {
		render: () => [],
		invalidate() {},
	};
	const projection: PiNativeAgentProjection = {
		kind: "live",
		sessionId: "projected-run",
		transcript: component,
		runStatus: component,
		dispose() {
			projectionDisposals += 1;
			if (options?.projectionDisposeError) throw options.projectionDisposeError;
		},
	};
	const session = {
		isIdle: true,
		isStreaming: false,
		pendingMessageCount: 0,
		subscribe() {
			if (options?.subscribeError) throw options.subscribeError;
			let subscribed = true;
			return () => {
				if (!subscribed) return;
				subscribed = false;
				unsubscriptions += 1;
			};
		},
		clearQueue: () => ({ steering: [], followUp: [] }),
		abort: async () => undefined,
		waitForIdle: async () => undefined,
		dispose() {
			sessionDisposals += 1;
		},
	} as unknown as AgentSession;
	return {
		startedRun: { session, projection },
		session,
		counts: () => ({
			projectionDisposals,
			sessionDisposals,
			unsubscriptions,
		}),
	};
}
