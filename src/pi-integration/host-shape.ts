import type {
	AgentSession,
	AgentSessionRuntime,
	ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

type UnknownRecord = Record<PropertyKey, unknown>;

export class IncompatiblePiHostError extends Error {
	readonly memberName: string;

	constructor(memberName: string, version?: unknown) {
		const versionDetail = typeof version === "string" ? ` (running Pi ${version})` : "";
		super(`Incompatible Pi host: missing or malformed ${memberName}${versionDetail}`);
		this.name = "IncompatiblePiHostError";
		this.memberName = memberName;
	}
}

export function assertExtensionApiShape(value: unknown): asserts value is ExtensionAPI {
	const api = requireRecord(value, "ExtensionAPI");
	for (const member of ["on", "registerTool", "registerCommand", "appendEntry"] as const) {
		requireFunction(api, member, `ExtensionAPI.${member}`);
	}
}

export function assertHostModuleShape(hostValue: unknown): void {
	const host = requireRecord(hostValue, "PiHost");
	const version = host.VERSION;

	for (const constructorName of [
		"AgentSessionRuntime",
		"InteractiveMode",
		"SessionManager",
		"DefaultResourceLoader",
		"ProjectTrustStore",
		"SettingsManager",
	] as const) {
		requireFunction(host, constructorName, constructorName, version);
	}
	for (const factoryName of [
		"createAgentSessionServices",
		"createAgentSessionFromServices",
		"defineTool",
		"hasTrustRequiringProjectResources",
	] as const) {
		requireFunction(host, factoryName, factoryName, version);
	}
	if (!Number.isInteger(host.CURRENT_SESSION_VERSION)) {
		throw new IncompatiblePiHostError("CURRENT_SESSION_VERSION", version);
	}
	requireFunction(
		host.SettingsManager as UnknownRecord,
		"create",
		"SettingsManager.create",
		version,
	);
	const projectTrustStorePrototype = requirePrototype(
		host.ProjectTrustStore,
		"ProjectTrustStore",
		version,
	);
	for (const member of ["get", "set"] as const) {
		requireFunction(
			projectTrustStorePrototype,
			member,
			`ProjectTrustStore.prototype.${member}`,
			version,
		);
	}

	const runtimePrototype = requirePrototype(host.AgentSessionRuntime, "AgentSessionRuntime", version);
	for (const member of ["setRebindSession", "setBeforeSessionInvalidate", "dispose"] as const) {
		requireFunction(
			runtimePrototype,
			member,
			`AgentSessionRuntime.prototype.${member}`,
			version,
		);
	}
	requireWritableMember(
		runtimePrototype,
		"dispose",
		"AgentSessionRuntime.prototype.dispose",
		version,
	);

	const interactivePrototype = requirePrototype(host.InteractiveMode, "InteractiveMode", version);
	for (const member of [
		"bindCurrentSessionExtensions",
		"rebindCurrentSession",
		"getUserInput",
	] as const) {
		requireFunction(
			interactivePrototype,
			member,
			`InteractiveMode.prototype.${member}`,
			version,
		);
	}
	requireWritableMember(
		interactivePrototype,
		"bindCurrentSessionExtensions",
		"InteractiveMode.prototype.bindCurrentSessionExtensions",
		version,
	);

	const sessionManager = host.SessionManager as UnknownRecord;
	for (const member of ["create", "open", "continueRecent", "inMemory"] as const) {
		requireFunction(sessionManager, member, `SessionManager.${member}`, version);
	}
	const sessionManagerPrototype = requirePrototype(host.SessionManager, "SessionManager", version);
	for (const member of [
		"appendCustomEntry",
		"appendCustomMessageEntry",
		"_rewriteFile",
		"getEntries",
		"getEntry",
		"getHeader",
		"getSessionId",
		"getSessionFile",
		"getSessionDir",
		"isPersisted",
		"getLeafId",
		"getCwd",
		"branch",
	] as const) {
		requireFunction(
			sessionManagerPrototype,
			member,
			`SessionManager.prototype.${member}`,
			version,
		);
	}

	const resourceLoaderPrototype = requirePrototype(
		host.DefaultResourceLoader,
		"DefaultResourceLoader",
		version,
	);
	for (const member of ["getExtensions", "getSkills", "reload"] as const) {
		requireFunction(
			resourceLoaderPrototype,
			member,
			`DefaultResourceLoader.prototype.${member}`,
			version,
		);
	}
}

export function assertTuiModuleShape(tuiValue: unknown, version?: unknown): void {
	const tui = requireRecord(tuiValue, "PiTUI", version);
	for (const member of [
		"Text",
		"matchesKey",
		"visibleWidth",
		"wrapTextWithAnsi",
	] as const) {
		requireFunction(tui, member, `PiTUI.${member}`, version);
	}
	const key = requireRecord(tui.Key, "PiTUI.Key", version);
	for (const member of [
		"backspace",
		"down",
		"enter",
		"escape",
		"left",
		"right",
		"space",
		"tab",
		"up",
	] as const) {
		requireMember(key, member, `PiTUI.Key.${member}`, version);
	}
	requireFunction(key, "shift", "PiTUI.Key.shift", version);
}

export function assertPiAiModuleShape(aiValue: unknown, version?: unknown): void {
	const ai = requireRecord(aiValue, "PiAI", version);
	requireFunction(
		ai,
		"createAssistantMessageEventStream",
		"PiAI.createAssistantMessageEventStream",
		version,
	);
}

export function assertTypeboxModuleShape(
	typeboxValue: unknown,
	version?: unknown,
): void {
	const typebox = requireRecord(typeboxValue, "TypeBox", version);
	const type = requireRecord(typebox.Type, "TypeBox.Type", version);
	for (const member of [
		"Array",
		"Boolean",
		"Integer",
		"Literal",
		"Object",
		"Optional",
		"String",
		"Union",
	] as const) {
		requireFunction(type, member, `TypeBox.Type.${member}`, version);
	}
}

export function assertRuntimeInstanceShape(
	runtimeValue: unknown,
	version?: unknown,
): asserts runtimeValue is AgentSessionRuntime {
	const runtime = requireRecord(runtimeValue, "AgentSessionRuntime", version);
	for (const member of ["_session", "_services", "_diagnostics", "_modelFallbackMessage"] as const) {
		requireWritableMember(runtime, member, `AgentSessionRuntime.${member}`, version);
	}
	for (const member of ["rebindSession", "beforeSessionInvalidate", "dispose"] as const) {
		requireFunction(runtime, member, `AgentSessionRuntime.${member}`, version);
	}
	requireWritableMember(runtime, "dispose", "AgentSessionRuntime.dispose", version);
	if (!Array.isArray(runtime.diagnostics)) {
		throw new IncompatiblePiHostError("AgentSessionRuntime.diagnostics", version);
	}
	const services = requireRecord(runtime.services, "AgentSessionRuntime.services", version);
	if (typeof services.cwd !== "string" || services.cwd.length === 0) {
		throw new IncompatiblePiHostError("AgentSessionRuntime.services.cwd", version);
	}
	if (typeof services.agentDir !== "string" || services.agentDir.length === 0) {
		throw new IncompatiblePiHostError("AgentSessionRuntime.services.agentDir", version);
	}
	const modelRuntime = requireRecord(
		services.modelRuntime,
		"AgentSessionRuntime.services.modelRuntime",
		version,
	);
	requireFunction(
		modelRuntime,
		"getModel",
		"AgentSessionRuntime.services.modelRuntime.getModel",
		version,
	);
	assertSettingsManagerShape(
		services.settingsManager,
		"AgentSessionRuntime.services.settingsManager",
		version,
	);
	const resourceLoader = requireRecord(
		services.resourceLoader,
		"AgentSessionRuntime.services.resourceLoader",
		version,
	);
	for (const member of ["getExtensions", "getSkills", "reload"] as const) {
		requireFunction(
			resourceLoader,
			member,
			`AgentSessionRuntime.services.resourceLoader.${member}`,
			version,
		);
	}
	assertAgentSessionShape(runtime.session, version);
}

export function assertInteractiveModeInstanceShape(value: unknown, version?: unknown): void {
	const interactiveMode = requireRecord(value, "InteractiveMode", version);
	const runtimeHost = requireRecord(
		interactiveMode.runtimeHost,
		"InteractiveMode.runtimeHost",
		version,
	);
	requireRecord(runtimeHost.session, "InteractiveMode.runtimeHost.session", version);
	const ui = requireRecord(interactiveMode.ui, "InteractiveMode.ui", version);
	requireFunction(ui, "requestRender", "InteractiveMode.ui.requestRender", version);
	for (const member of [
		"bindCurrentSessionExtensions",
		"rebindCurrentSession",
		"getUserInput",
		"setWorkingVisible",
		"clearStatusIndicator",
		"showError",
	] as const) {
		requireFunction(interactiveMode, member, `InteractiveMode.${member}`, version);
	}
}

export function assertAgentSessionShape(
	sessionValue: unknown,
	version?: unknown,
): asserts sessionValue is AgentSession {
	const session = requireRecord(sessionValue, "AgentSession", version);
	for (const member of [
		"prompt",
		"sendUserMessage",
		"sendCustomMessage",
		"clearQueue",
		"subscribe",
		"bindExtensions",
		"abort",
		"waitForIdle",
		"dispose",
		"getActiveToolNames",
		"getToolDefinition",
	] as const) {
		requireFunction(session, member, `AgentSession.${member}`, version);
	}
	requireWritableMember(session, "bindExtensions", "AgentSession.bindExtensions", version);
	for (const member of [
		"model",
		"thinkingLevel",
		"isIdle",
		"sessionId",
		"_extensionUIContext",
		"_extensionMode",
		"_extensionCommandContextActions",
		"_extensionAbortHandler",
		"_extensionShutdownHandler",
		"_extensionErrorListener",
	] as const) {
		requireMember(session, member, `AgentSession.${member}`, version);
	}
	for (const member of [
		"_extensionUIContext",
		"_extensionMode",
		"_extensionCommandContextActions",
		"_extensionAbortHandler",
		"_extensionShutdownHandler",
		"_extensionErrorListener",
	] as const) {
		requireWritableMember(session, member, `AgentSession.${member}`, version);
	}
	requireFunction(session, "_applyExtensionBindings", "AgentSession._applyExtensionBindings", version);
	requireFunction(session, "_runAgentPrompt", "AgentSession._runAgentPrompt", version);
	requireRecord(session.extensionRunner, "AgentSession.extensionRunner", version);
	const sessionManager = requireRecord(
		session.sessionManager,
		"AgentSession.sessionManager",
		version,
	);
	if (typeof sessionManager.flushed !== "boolean") {
		throw new IncompatiblePiHostError("AgentSession.sessionManager.flushed", version);
	}
	assertSettingsManagerShape(
		session.settingsManager,
		"AgentSession.settingsManager",
		version,
	);
	const agent = requireRecord(session.agent, "AgentSession.agent", version);
	requireFunction(
		agent,
		"streamFunction",
		"AgentSession.agent.streamFunction",
		version,
	);
	requireWritableMember(
		agent,
		"streamFunction",
		"AgentSession.agent.streamFunction",
		version,
	);
	requireWritableMember(agent, "transport", "AgentSession.agent.transport", version);
}

function assertSettingsManagerShape(
	value: unknown,
	name: string,
	version?: unknown,
): void {
	const settingsManager = requireRecord(value, name, version);
	for (const member of [
		"applyOverrides",
		"getDefaultProjectTrust",
		"getProviderRetrySettings",
		"getTransport",
		"isProjectTrusted",
	] as const) {
		requireFunction(settingsManager, member, `${name}.${member}`, version);
	}
}

function requirePrototype(value: unknown, name: string, version?: unknown): UnknownRecord {
	const constructor = requireRecord(value, name, version);
	return requireRecord(constructor.prototype, `${name}.prototype`, version);
}

function requireRecord(value: unknown, name: string, version?: unknown): UnknownRecord {
	if ((typeof value !== "object" && typeof value !== "function") || value === null) {
		throw new IncompatiblePiHostError(name, version);
	}
	return value as UnknownRecord;
}

function requireMember(
	record: UnknownRecord,
	member: PropertyKey,
	name: string,
	version?: unknown,
): void {
	if (!(member in record)) throw new IncompatiblePiHostError(name, version);
}

function requireFunction(
	record: UnknownRecord,
	member: PropertyKey,
	name: string,
	version?: unknown,
): void {
	if (typeof record[member] !== "function") throw new IncompatiblePiHostError(name, version);
}

function requireWritableMember(
	record: UnknownRecord,
	member: PropertyKey,
	name: string,
	version?: unknown,
): void {
	requireMember(record, member, name, version);
	let owner: object | null = record;
	while (owner !== null) {
		const descriptor = Object.getOwnPropertyDescriptor(owner, member);
		if (descriptor) {
			if (
				("writable" in descriptor && descriptor.writable) ||
				("set" in descriptor && typeof descriptor.set === "function")
			) return;
			throw new IncompatiblePiHostError(name, version);
		}
		owner = Object.getPrototypeOf(owner) as object | null;
	}
	throw new IncompatiblePiHostError(name, version);
}
