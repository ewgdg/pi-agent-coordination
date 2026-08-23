import type {
	Agent,
	AgentEvent,
	AgentMessage,
} from "@earendil-works/pi-agent-core";
export type OwnerSettlementParkingBinding = Readonly<{
	dispose(): void;
}>;

type OwnerSettlementParkingOptions = Readonly<{
	agent: Agent;
	hasOutstandingRequests(): boolean;
	beginParking(
		runSignal: AbortSignal,
	): Promise<(() => void | Promise<void>) | undefined> |
		(() => void | Promise<void>) |
		undefined;
	shutdownSignal?: AbortSignal;
	reportError?(error: unknown): void;
}>;

type QueueWaiter = Readonly<{
	promise: Promise<void>;
	wake(): void;
	dispose(): void;
}>;

type InstalledParking = {
	options: OwnerSettlementParkingOptions;
	referenceCount: number;
	disposed: AbortController;
	waiters: Set<() => void>;
	unsubscribe(): void;
	restoreObservedMethods(): void;
};

const installedByAgent = new WeakMap<Agent, InstalledParking>();

/**
 * Keep one Owner Agent-core run open until turn-triggering input reaches an
 * active queue. Pi's AgentSession listener is installed in its constructor, so
 * this later subscription runs only after Pi and every extension handler finish.
 */
export function installOwnerSettlementParker(
	options: OwnerSettlementParkingOptions,
): OwnerSettlementParkingBinding {
	let installed = installedByAgent.get(options.agent);
	if (!installed) {
		installed = createInstalledParking(options);
		installedByAgent.set(options.agent, installed);
	} else {
		installed.referenceCount += 1;
	}

	let released = false;
	return Object.freeze({
		dispose() {
			if (released) return;
			released = true;
			installed!.referenceCount -= 1;
			if (installed!.referenceCount > 0) return;
			installed!.disposed.abort();
			installed!.unsubscribe();
			installed!.restoreObservedMethods();
			installedByAgent.delete(options.agent);
		},
	});
}

function createInstalledParking(
	options: OwnerSettlementParkingOptions,
): InstalledParking {
	const installed: InstalledParking = {
		options,
		referenceCount: 1,
		disposed: new AbortController(),
		waiters: new Set(),
		unsubscribe: () => undefined,
		restoreObservedMethods: () => undefined,
	};
	const restoreQueueMethods = observeQueueAdmissions(options.agent, () => {
		for (const wake of [...installed.waiters]) wake();
	});
	installed.restoreObservedMethods = restoreQueueMethods;
	installed.unsubscribe = options.agent.subscribe((event, signal) =>
		parkAtCandidateBoundary(installed, event, signal)
	);
	return installed;
}

async function parkAtCandidateBoundary(
	installed: InstalledParking,
	event: AgentEvent,
	runSignal: AbortSignal,
): Promise<void> {
	if (
		event.type !== "agent_end" ||
		!normallyCompleted(event) ||
		installed.options.agent.hasQueuedMessages()
	) return;
	try {
		if (!installed.options.hasOutstandingRequests()) return;
	} catch (error) {
		reportParkingError(installed, error);
		return;
	}

	const waiter = createQueueWaiter(installed, [
		runSignal,
		installed.options.shutdownSignal,
		installed.disposed.signal,
	]);
	let leaveParking: (() => void | Promise<void>) | undefined;
	try {
		// The waiter exists before parking entry re-drains scheduler-held Delivery.
		// The authoritative queue check below closes admission before installation.
		leaveParking = await installed.options.beginParking(runSignal);
		if (!leaveParking || installed.options.agent.hasQueuedMessages()) waiter.wake();
		await waiter.promise;
	} catch (error) {
		reportParkingError(installed, error);
	} finally {
		waiter.dispose();
		try {
			await leaveParking?.();
		} catch (error) {
			reportParkingError(installed, error);
		}
	}
}

function reportParkingError(installed: InstalledParking, error: unknown): void {
	try {
		installed.options.reportError?.(error);
	} catch {
		// Diagnostics must never turn a successful Pi response into Agent failure.
	}
}

function normallyCompleted(
	event: Extract<AgentEvent, { type: "agent_end" }>,
): boolean {
	const assistant = [...event.messages]
		.reverse()
		.find((message) => message.role === "assistant");
	return assistant?.role === "assistant" &&
		(assistant.stopReason === "stop" || assistant.stopReason === "toolUse");
}

function createQueueWaiter(
	installed: InstalledParking,
	signals: readonly (AbortSignal | undefined)[],
): QueueWaiter {
	let settle!: () => void;
	let settled = false;
	const promise = new Promise<void>((resolve) => {
		settle = resolve;
	});
	const abortHandlers: Array<Readonly<{ signal: AbortSignal; handler(): void }>> = [];
	const wake = () => {
		if (settled) return;
		settled = true;
		installed.waiters.delete(wake);
		for (const { signal, handler } of abortHandlers) {
			signal.removeEventListener("abort", handler);
		}
		settle();
	};
	installed.waiters.add(wake);
	for (const signal of signals) {
		if (!signal) continue;
		if (signal.aborted) {
			wake();
			break;
		}
		const handler = () => wake();
		abortHandlers.push({ signal, handler });
		signal.addEventListener("abort", handler, { once: true });
	}
	return {
		promise,
		wake,
		dispose: wake,
	};
}

function observeQueueAdmissions(agent: Agent, notify: () => void): () => void {
	const steerDescriptor = Object.getOwnPropertyDescriptor(agent, "steer");
	const followUpDescriptor = Object.getOwnPropertyDescriptor(agent, "followUp");
	const steer = agent.steer;
	const followUp = agent.followUp;

	agent.steer = function observedSteer(message: AgentMessage): void {
		steer.call(agent, message);
		notify();
	};
	agent.followUp = function observedFollowUp(message: AgentMessage): void {
		followUp.call(agent, message);
		notify();
	};

	return () => {
		restoreMethod(agent, "steer", steerDescriptor);
		restoreMethod(agent, "followUp", followUpDescriptor);
	};
}

function restoreMethod<
	Target extends object,
	Name extends keyof Target,
>(
	target: Target,
	name: Name,
	descriptor: PropertyDescriptor | undefined,
): void {
	if (descriptor) {
		Object.defineProperty(target, name, descriptor);
		return;
	}
	Reflect.deleteProperty(target, name);
}
