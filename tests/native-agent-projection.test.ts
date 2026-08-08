import assert from "node:assert/strict";
import test from "node:test";

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
	InteractiveMode,
	SessionManager,
	createAgentSessionFromServices,
	createAgentSessionServices,
	initTheme,
} from "@earendil-works/pi-coding-agent";
import {
	getKeybindings,
	stripTerminalSequences,
} from "@earendil-works/pi-tui";

import { IncompatiblePiHostError } from "../src/pi-integration/host-shape.ts";
import { adoptOrValidateOwnerIdentity } from "../src/protocol/owner-identity.ts";
import { DefaultChildSessionFactory } from "../src/runtime/default-child-session-factory.ts";
import {
	createPiNativeProjectionHost,
} from "../src/pi-integration/native-agent-projection.ts";
import {
	createTestOwnerHost,
} from "./support/pi-host.ts";

const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
const RENDER_WIDTH = 80;

function renderText(component: { render(width: number): string[] }): string {
	return stripTerminalSequences(component.render(RENDER_WIDTH).join("\n"));
}

test("a real live InteractiveMode projection reconstructs transcript and follows Run status events", async () => {
	const host = await createTestOwnerHost(() => undefined, { persistent: true });
	initTheme("dark");
	const projectionHost = createPiNativeProjectionHost({
		ownerRuntime: host.runtime,
		ownerInteractiveMode: {
			themeController: { activeThemeName: "<in-memory>" },
		},
	});
	const ownerSession = host.runtime.session;
	const ownerServices = host.runtime.services;
	const mutableOwnerRuntime = host.runtime as unknown as {
		rebindSession: unknown;
		beforeSessionInvalidate: unknown;
	};
	const ownerRebindSession = mutableOwnerRuntime.rebindSession;
	const ownerBeforeSessionInvalidate = mutableOwnerRuntime.beforeSessionInvalidate;
	const ownerKeybindings = getKeybindings();
	const ownerTheme = (globalThis as Record<PropertyKey, unknown>)[THEME_KEY];
	let releaseResponse!: () => void;
	const responseGate = new Promise<void>((resolve) => {
		releaseResponse = resolve;
	});
	let markResponseStarted!: () => void;
	const responseStarted = new Promise<void>((resolve) => {
		markResponseStarted = resolve;
	});
	host.model.setResponses([
		async () => {
			markResponseStarted();
			await responseGate;
			return fauxAssistantMessage("Projection received the complete live response.");
		},
	]);

	const projection = await projectionHost.createProjection({
		kind: "live",
		session: ownerSession,
		services: ownerServices,
	});
	assert.equal(projection.kind, "live");
	assert.equal(host.runtime.session, ownerSession);
	assert.equal(host.runtime.services, ownerServices);
	assert.equal(mutableOwnerRuntime.rebindSession, ownerRebindSession);
	assert.equal(
		mutableOwnerRuntime.beforeSessionInvalidate,
		ownerBeforeSessionInvalidate,
	);
	assert.equal(getKeybindings(), ownerKeybindings);
	assert.equal((globalThis as Record<PropertyKey, unknown>)[THEME_KEY], ownerTheme);

	const prompt = ownerSession.prompt("Render this live transcript through Pi.");
	await responseStarted;
	await waitForCondition(() => renderText(projection.runStatus).includes("Working"));
	assert.match(renderText(projection.transcript), /Render this live transcript through Pi/);

	releaseResponse();
	await prompt;
	await ownerSession.waitForIdle();
	await waitForCondition(() =>
		renderText(projection.transcript).includes("Projection received the complete live response.")
	);
	assert.equal(renderText(projection.runStatus).includes("Working"), false);
	projection.dispose();
	projection.dispose();
	assert.equal(host.runtime.session, ownerSession);
	assert.equal(host.runtime.services, ownerServices);
	assert.equal(mutableOwnerRuntime.rebindSession, ownerRebindSession);
	assert.equal(
		mutableOwnerRuntime.beforeSessionInvalidate,
		ownerBeforeSessionInvalidate,
	);
	assert.equal(getKeybindings(), ownerKeybindings);
	assert.equal((globalThis as Record<PropertyKey, unknown>)[THEME_KEY], ownerTheme);
	await host.runtime.dispose();
});

test("projection compatibility failure restores Owner globals before subscribing", async () => {
	const host = await createTestOwnerHost(() => undefined, { persistent: true });
	initTheme("dark");
	const ownerKeybindings = getKeybindings();
	const ownerTheme = (globalThis as Record<PropertyKey, unknown>)[THEME_KEY];
	const projectionHost = createPiNativeProjectionHost({
		ownerRuntime: host.runtime,
		ownerInteractiveMode: {
			themeController: { activeThemeName: "<in-memory>" },
		},
	});
	const prototype = InteractiveMode.prototype as unknown as {
		subscribeToAgent: unknown;
	};
	const nativeSubscribeToAgent = prototype.subscribeToAgent;
	const nativeSubscribe = host.session.subscribe;
	let projectionSubscriptions = 0;
	host.session.subscribe = ((listener) => {
		projectionSubscriptions += 1;
		return nativeSubscribe.call(host.session, listener);
	}) as typeof host.session.subscribe;
	prototype.subscribeToAgent = undefined;
	try {
		await assert.rejects(
			() => projectionHost.createProjection({
				kind: "live",
				session: host.session,
				services: host.services,
			}),
			(error: unknown) =>
				error instanceof IncompatiblePiHostError &&
				error.memberName === "InteractiveMode.subscribeToAgent",
		);
	} finally {
		prototype.subscribeToAgent = nativeSubscribeToAgent;
		host.session.subscribe = nativeSubscribe;
	}
	assert.equal(projectionSubscriptions, 0);
	assert.equal(getKeybindings(), ownerKeybindings);
	assert.equal((globalThis as Record<PropertyKey, unknown>)[THEME_KEY], ownerTheme);
	await host.runtime.dispose();
});

test("session_start model work begins only after the live projection is subscribed", async () => {
	const host = await createTestOwnerHost(() => undefined, { persistent: true });
	const ownerIdentity = adoptOrValidateOwnerIdentity(
		host.runtime,
		"<inline:pi-agent-coordination>",
	);
	const factory = new DefaultChildSessionFactory({
		ownerRuntime: host.runtime,
		ownerIdentity,
		entryModulePath: "<inline:pi-agent-coordination>",
		packageRoot: host.cwd,
		childExtensionFactory: () => () => undefined,
		moderatorExtensionFactory: () => () => undefined,
		presentationExtensionFactory: () => () => undefined,
	});
	let markResponseStarted!: () => void;
	const responseStarted = new Promise<void>((resolve) => {
		markResponseStarted = resolve;
	});
	let releaseResponse!: () => void;
	const responseGate = new Promise<void>((resolve) => {
		releaseResponse = resolve;
	});
	host.model.setResponses([
		async () => {
			markResponseStarted();
			await responseGate;
			return fauxAssistantMessage("Child startup model work completed.");
		},
	]);
	const model = host.session.model;
	assert.ok(model);
	const childServices = await createAgentSessionServices({
		cwd: host.cwd,
		agentDir: host.services.agentDir,
		modelRuntime: host.services.modelRuntime,
		settingsManager: host.services.settingsManager,
		resourceLoaderOptions: {
			noContextFiles: true,
			noPromptTemplates: true,
			noSkills: true,
			noThemes: true,
			extensionFactories: [{
				name: "session-start-model-work-probe",
				hidden: true,
				factory(pi) {
					pi.on("session_start", () => {
						pi.sendUserMessage("Model work emitted by child session_start.");
					});
				},
			}],
		},
	});
	const startedRun = await factory.startSession({
		sessionManager: SessionManager.inMemory(host.cwd),
		prepared: {
			services: childServices,
			configuration: {
				cwd: host.cwd,
				model: { provider: model.provider, modelId: model.id },
				thinking: "off",
				tools: [],
				skills: [],
				extensions: [],
			},
		},
	});
	await responseStarted;
	const statusDuringStartupWork = renderText(startedRun.projection.runStatus);

	releaseResponse();
	await startedRun.session.waitForIdle();
	startedRun.projection.dispose();
	startedRun.session.dispose();
	await host.runtime.dispose();
	assert.match(statusDuringStartupWork, /Working/);
});

test("projection construction failure disposes a partially started real Run session once", async () => {
	const host = await createTestOwnerHost(() => undefined, { persistent: true });
	const ownerIdentity = adoptOrValidateOwnerIdentity(
		host.runtime,
		"<inline:pi-agent-coordination>",
	);
	let childSessionDisposals = 0;
	const factory = new DefaultChildSessionFactory({
		ownerRuntime: host.runtime,
		ownerIdentity,
		entryModulePath: "<inline:pi-agent-coordination>",
		packageRoot: host.cwd,
		childExtensionFactory: () => () => undefined,
		moderatorExtensionFactory: () => () => undefined,
		presentationExtensionFactory: () => () => undefined,
		projectionHost: {
			async createProjection({ session }) {
				const nativeDispose = session.dispose.bind(session);
				session.dispose = () => {
					childSessionDisposals += 1;
					nativeDispose();
				};
				throw new Error("confirmed projection constructor failure");
			},
		},
	});
	const model = host.session.model;
	assert.ok(model);
	let childModelRequests = 0;
	host.model.setResponses([
		() => {
			childModelRequests += 1;
			return fauxAssistantMessage("This response must never start.");
		},
	]);
	const childServices = await createAgentSessionServices({
		cwd: host.cwd,
		agentDir: host.services.agentDir,
		modelRuntime: host.services.modelRuntime,
		settingsManager: host.services.settingsManager,
		resourceLoaderOptions: {
			noContextFiles: true,
			noPromptTemplates: true,
			noSkills: true,
			noThemes: true,
			extensionFactories: [{
				name: "failed-session-start-model-work-probe",
				hidden: true,
				factory(pi) {
					pi.on("session_start", () => {
						pi.sendUserMessage("Do not admit failed child startup work.");
					});
				},
			}],
		},
	});

	await assert.rejects(
		() => factory.startSession({
			sessionManager: SessionManager.inMemory(host.cwd),
			prepared: {
				services: childServices,
				configuration: {
					cwd: host.cwd,
					model: { provider: model.provider, modelId: model.id },
					thinking: "off",
					tools: [],
					skills: [],
					extensions: [],
				},
			},
		}),
		/confirmed projection constructor failure/,
	);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(childSessionDisposals, 1);
	assert.equal(childModelRequests, 0);
	assert.equal(host.runtime.session, host.session);
	await host.runtime.dispose();
});

test("a Dormant projection renders durable evidence without tools, model work, or transcript writes", async () => {
	const host = await createTestOwnerHost(() => undefined, { persistent: true });
	host.model.setResponses([
		fauxAssistantMessage("Durable transcript evidence remains presentation-only."),
	]);
	await host.session.prompt("Persist evidence for passive inspection.");
	await host.session.waitForIdle();
	const sessionFile = host.session.sessionManager.getSessionFile();
	assert.ok(sessionFile);
	const durableSessionManager = SessionManager.open(sessionFile);
	const entriesBefore = durableSessionManager.getEntries();
	const created = await createAgentSessionFromServices({
		services: host.services,
		sessionManager: durableSessionManager,
		noTools: "all",
	});
	const passiveSession = created.session;
	await passiveSession.bindExtensions({ mode: "tui", uiContext: host.ui });
	passiveSession.setActiveToolsByName([]);
	const projectionHost = createPiNativeProjectionHost({ ownerRuntime: host.runtime });

	const projection = await projectionHost.createProjection({
		kind: "dormant",
		session: passiveSession,
		services: host.services,
	});
	assert.equal(projection.kind, "dormant");
	assert.deepEqual(passiveSession.getActiveToolNames(), []);
	assert.match(renderText(projection.transcript), /Persist evidence for passive inspection/);
	assert.match(
		renderText(projection.transcript),
		/Durable transcript evidence remains presentation-only/,
	);
	assert.equal(renderText(projection.runStatus), "");
	assert.deepEqual(durableSessionManager.getEntries(), entriesBefore);

	projection.dispose();
	passiveSession.dispose();
	assert.deepEqual(SessionManager.open(sessionFile).getEntries(), entriesBefore);
	await host.runtime.dispose();
});

async function waitForCondition(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 1_000; attempt += 1) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error("Timed out waiting for projection state");
}
