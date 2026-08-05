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
	] as const) {
		requireFunction(host, constructorName, constructorName, version);
	}
	for (const factoryName of [
		"createAgentSessionServices",
		"createAgentSessionFromServices",
		"defineTool",
	] as const) {
		requireFunction(host, factoryName, factoryName, version);
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

export function assertRuntimeInstanceShape(
	runtimeValue: unknown,
	version?: unknown,
): asserts runtimeValue is AgentSessionRuntime {
	const runtime = requireRecord(runtimeValue, "AgentSessionRuntime", version);
	for (const member of ["_session", "_services", "_diagnostics", "_modelFallbackMessage"] as const) {
		requireMember(runtime, member, `AgentSessionRuntime.${member}`, version);
	}
	for (const member of ["rebindSession", "beforeSessionInvalidate"] as const) {
		requireFunction(runtime, member, `AgentSessionRuntime.${member}`, version);
	}
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
	requireRecord(
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
	requireFunction(session, "_applyExtensionBindings", "AgentSession._applyExtensionBindings", version);
	requireFunction(session, "_runAgentPrompt", "AgentSession._runAgentPrompt", version);
	requireRecord(session.extensionRunner, "AgentSession.extensionRunner", version);
	requireRecord(session.sessionManager, "AgentSession.sessionManager", version);
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
