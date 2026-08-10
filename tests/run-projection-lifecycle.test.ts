import assert from "node:assert/strict";
import test from "node:test";

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
	SessionManager,
	createAgentSessionFromServices,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";
import {
	stripTerminalSequences,
	type Component,
} from "@earendil-works/pi-tui";

import {
	createPiNativeProjectionHost,
	type PiNativeAgentProjection,
} from "../src/pi-integration/native-agent-projection.ts";
import { InProcessAgentHost } from "../src/runtime/in-process-agent-host.ts";
import { createTestOwnerHost } from "./support/pi-host.ts";

const PROJECTION_RENDER_WIDTH = 120;

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

test("selected clean Runs release inside one retained Runtime", async () => {
	const resource = createRunResource();
	let runtimePreparations = 0;
	const host = InProcessAgentHost.createChild({
		sessionManager: SessionManager.inMemory(),
		startSession: async () => {
			runtimePreparations += 1;
			return resource.startedRun;
		},
	});
	const ended: Array<{ sequence: number; cause: string }> = [];
	host.addEndedHandler((handle, cause) => {
		ended.push({ sequence: handle.sequence, cause });
	});

	const preparedSession = await host.lane.run(() =>
		host.prepareInLane(["interactive_selection"])
	);
	const preparedProjection = host.currentProjection();
	await host.lane.run(() => host.startInLane());
	const firstHandle = host.currentHandle();
	assert.ok(firstHandle);
	assert.equal(
		await host.lane.run(() => host.releaseIfEligibleInLane(firstHandle)),
		"released",
	);
	assert.equal(host.observe().phase, "dormant");
	assert.equal(host.currentProjection(), preparedProjection);
	assert.deepEqual(resource.counts(), {
		projectionDisposals: 0,
		sessionDisposals: 0,
		unsubscriptions: 0,
	});

	assert.equal(await host.lane.run(() => host.startInLane()), preparedSession);
	const secondHandle = host.currentHandle();
	assert.ok(secondHandle);
	assert.notEqual(secondHandle, firstHandle);
	assert.equal(secondHandle.sequence, firstHandle.sequence + 1);
	assert.equal(host.currentProjection(), preparedProjection);
	assert.equal(runtimePreparations, 1);

	host.removeRetentionReason("interactive_selection");
	assert.equal(
		await host.lane.run(() => host.releaseIfEligibleInLane(secondHandle)),
		"released",
	);
	assert.deepEqual(ended, [
		{ sequence: firstHandle.sequence, cause: "clean" },
		{ sequence: secondHandle.sequence, cause: "clean" },
	]);
	assert.deepEqual(resource.counts(), {
		projectionDisposals: 1,
		sessionDisposals: 1,
		unsubscriptions: 1,
	});
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

test("failed startup emits the exact Run terminal lifecycle before disposal", async () => {
	const resource = createRunResource();
	const events: string[] = [];
	const host = InProcessAgentHost.createChild({
		sessionManager: SessionManager.inMemory(),
		startSession: async () => ({
			...resource.startedRun,
			ready: Promise.reject(new Error("session_start rejected")),
		}),
	});
	host.setRunEndingHandler((_session, _handle, cause) => {
		events.push(`ending:${cause}`);
		assert.equal(resource.counts().projectionDisposals, 0);
	});
	host.addEndedHandler((_handle, cause) => {
		events.push(`ended:${cause}`);
		assert.equal(host.observe().phase, "dormant");
	});

	await assert.rejects(
		() => host.lane.run(() => host.startInLane()),
		/session_start rejected/,
	);
	assert.deepEqual(events, ["ending:failure", "ended:failure"]);
	assert.deepEqual(resource.counts(), {
		projectionDisposals: 1,
		sessionDisposals: 1,
		unsubscriptions: 1,
	});
});

test("post-binding startup failure cancels and observes pending exact readiness", async () => {
	const resource = createRunResource();
	const handlerFailure = new Error("post-binding handler failed before readiness");
	let rejectReady!: (error: unknown) => void;
	const ready = new Promise<void>((_resolve, reject) => {
		rejectReady = reject;
	});
	const nativeProjection = resource.startedRun.projection;
	const projection: PiNativeAgentProjection = {
		...nativeProjection,
		ready: () => ready,
		cancelInitialization(error) {
			rejectReady(error);
			return Promise.resolve();
		},
	};
	const host = InProcessAgentHost.createChild({
		sessionManager: SessionManager.inMemory(),
		startSession: async () => ({
			session: resource.session,
			projection,
			ready,
		}),
	});
	const lifecycle: string[] = [];
	host.setRunStartedHandler(() => {
		throw handlerFailure;
	});
	host.setRunEndingHandler((_session, _handle, cause) => {
		lifecycle.push(`ending:${cause}`);
	});
	host.addEndedHandler((_handle, cause) => lifecycle.push(`ended:${cause}`));

	await assert.rejects(
		() => host.lane.run(() => host.startInLane()),
		handlerFailure,
	);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(lifecycle, ["ending:failure", "ended:failure"]);
	assert.deepEqual(resource.counts(), {
		projectionDisposals: 1,
		sessionDisposals: 1,
		unsubscriptions: 1,
	});
	assert.equal(host.observe().phase, "dormant");
});

test("shutdown fencing prevents a prepared Runtime from admitting a Run", async () => {
	const resource = createRunResource();
	const host = InProcessAgentHost.createChild({
		sessionManager: SessionManager.inMemory(),
		startSession: async () => resource.startedRun,
	});
	let relationshipInitializations = 0;
	host.setRunStartInitializer(() => {
		relationshipInitializations += 1;
		return {
			awaitingAnswerRequestIds: [],
			answerOwedRequestIds: [],
		};
	});

	await host.lane.run(() => host.prepareInLane(["interactive_selection"]));
	assert.equal(host.observe().phase, "dormant");
	assert.equal(host.latestStartedRunSequence(), 0);
	assert.equal(await host.beginShutdown(), false);

	await assert.rejects(
		() => host.lane.run(() => host.startInLane(["pending_delivery"])),
		/host_shutting_down: Agent Run startup is closed/,
	);
	assert.equal(host.observe().phase, "dormant");
	assert.equal(host.hasRetentionReason("pending_delivery"), false);
	assert.equal(host.latestStartedRunSequence(), 0);
	assert.equal(relationshipInitializations, 0);

	host.removeRetentionReason("interactive_selection");
	assert.equal(
		await host.lane.run(() => host.releasePreparedRuntimeInLane()),
		"released",
	);
	assert.deepEqual(resource.counts(), {
		projectionDisposals: 1,
		sessionDisposals: 1,
		unsubscriptions: 1,
	});
});

test("shutdown fenced before projection binding observes accepted startup cancellation", async () => {
	const resource = createRunResource();
	let markPreparationStarted!: () => void;
	const preparationStarted = new Promise<void>((resolve) => {
		markPreparationStarted = resolve;
	});
	let releasePreparation!: () => void;
	const preparationGate = new Promise<void>((resolve) => {
		releasePreparation = resolve;
	});
	let rejectReady!: (error: unknown) => void;
	const ready = new Promise<void>((_resolve, reject) => {
		rejectReady = reject;
	});
	let disposal: Promise<void> | undefined;
	const nativeProjection = resource.startedRun.projection;
	const projection: PiNativeAgentProjection = {
		...nativeProjection,
		ready: () => ready,
		cancelInitialization(error) {
			rejectReady(error);
			disposal ??= nativeProjection.dispose();
			return disposal;
		},
		dispose() {
			disposal ??= nativeProjection.dispose();
			return disposal;
		},
	};
	const host = InProcessAgentHost.createChild({
		sessionManager: SessionManager.inMemory(),
		startSession: async () => {
			markPreparationStarted();
			await preparationGate;
			return { session: resource.session, projection, ready };
		},
	});
	const endedCauses: string[] = [];
	host.addEndedHandler((_handle, cause) => endedCauses.push(cause));
	const startup = host.lane.run(() => host.startInLane());
	await preparationStarted;
	assert.equal(await host.beginShutdown(), false);
	releasePreparation();

	await assert.rejects(startup, /Workflow shutdown during Agent Run initialization/);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(endedCauses, ["termination"]);
	assert.deepEqual(resource.counts(), {
		projectionDisposals: 1,
		sessionDisposals: 1,
		unsubscriptions: 1,
	});
	assert.equal(host.observe().phase, "dormant");
});

test("a naturally rejected startup remains Run Failure after a pre-binding shutdown fence", async () => {
	const resource = createRunResource();
	let markPreparationStarted!: () => void;
	const preparationStarted = new Promise<void>((resolve) => {
		markPreparationStarted = resolve;
	});
	let releasePreparation!: () => void;
	const preparationGate = new Promise<void>((resolve) => {
		releasePreparation = resolve;
	});
	const naturalFailure = new Error("natural startup failure won before shutdown cancellation");
	let rejectReady!: (error: unknown) => void;
	const ready = new Promise<void>((_resolve, reject) => {
		rejectReady = reject;
	});
	const nativeProjection = resource.startedRun.projection;
	const projection: PiNativeAgentProjection = {
		...nativeProjection,
		ready: () => ready,
		cancelInitialization() {
			rejectReady(naturalFailure);
			return undefined;
		},
	};
	const host = InProcessAgentHost.createChild({
		sessionManager: SessionManager.inMemory(),
		startSession: async () => {
			markPreparationStarted();
			await preparationGate;
			return { session: resource.session, projection, ready };
		},
	});
	const endedCauses: string[] = [];
	host.addEndedHandler((_handle, cause) => endedCauses.push(cause));
	const startup = host.lane.run(() => host.startInLane());
	await preparationStarted;
	assert.equal(await host.beginShutdown(), false);
	releasePreparation();

	await assert.rejects(startup, naturalFailure);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(endedCauses, ["failure"]);
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

test("termination keeps the projection subscribed through final Run settlement", async () => {
	const ownerHost = await createTestOwnerHost(() => undefined, { persistent: true });
	let markResponseStarted!: () => void;
	const responseStarted = new Promise<void>((resolve) => {
		markResponseStarted = resolve;
	});
	let releaseResponse!: () => void;
	const responseGate = new Promise<void>((resolve) => {
		releaseResponse = resolve;
	});
	ownerHost.model.setResponses([
		async () => {
			markResponseStarted();
			await responseGate;
			return fauxAssistantMessage("This response is aborted during termination.");
		},
	]);
	const model = ownerHost.session.model;
	assert.ok(model);
	const created = await createAgentSessionFromServices({
		services: ownerHost.services,
		sessionManager: SessionManager.inMemory(ownerHost.cwd),
		model,
		thinkingLevel: "off",
		noTools: "all",
	});
	const session = created.session;
	await session.bindExtensions({ mode: "tui", uiContext: ownerHost.ui });
	const events: string[] = [];
	let eventsAtProjectionDisposal: readonly string[] = [];
	let statusAtProjectionDisposal = "";
	let transcriptAtProjectionDisposal = "";
	let projectionDisposals = 0;
	const unsubscribeEventProbe = session.subscribe((event) => {
		events.push(event.type);
	});
	const nativeProjection = await createPiNativeProjectionHost({
		ownerRuntime: ownerHost.runtime,
	}).createProjection({
		session,
		services: ownerHost.services,
	});
	const projection: PiNativeAgentProjection = {
		...nativeProjection,
		async dispose() {
			projectionDisposals += 1;
			eventsAtProjectionDisposal = [...events];
			statusAtProjectionDisposal = stripTerminalSequences(
				nativeProjection.presentation.render(PROJECTION_RENDER_WIDTH).join("\n"),
			);
			transcriptAtProjectionDisposal = stripTerminalSequences(
				nativeProjection.presentation.render(PROJECTION_RENDER_WIDTH).join("\n"),
			);
			unsubscribeEventProbe();
			await nativeProjection.dispose();
		},
	};
	const agentHost = InProcessAgentHost.createChild({
		sessionManager: session.sessionManager,
		startSession: async () => ({ session, projection }),
	});
	await agentHost.lane.run(() => agentHost.startInLane());
	const prompt = session.prompt("Keep the projection until this Run settles.");
	await responseStarted;
	const nativeAbort = session.abort.bind(session);
	session.abort = async () => {
		releaseResponse();
		await nativeAbort();
	};

	await agentHost.lane.run(() => agentHost.discardAndEndInLane("termination"));
	await prompt;
	assert.equal(projectionDisposals, 1);
	assert.equal(eventsAtProjectionDisposal.includes("agent_end"), true);
	assert.equal(eventsAtProjectionDisposal.includes("agent_settled"), true);
	assert.equal(statusAtProjectionDisposal.includes("Working"), false);
	assert.match(transcriptAtProjectionDisposal, /Operation aborted/);
	await ownerHost.runtime.dispose();
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
		sessionId: "projected-run",
		presentation: component,
		resize() {},
		dispatchInput() {},
		focusEditor() {},
		addChangeHandler: () => () => undefined,
		addFailureHandler: () => () => undefined,
		addExitRequestHandler: () => () => undefined,
		isProcessingInput: () => false,
		whenInputIdle: async () => undefined,
		async ready() {},
		cancelInitialization() {
			return undefined;
		},
		async dispose() {
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
