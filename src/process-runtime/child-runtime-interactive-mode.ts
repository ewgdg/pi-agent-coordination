import * as hostPi from "@earendil-works/pi-coding-agent";

type InputLifecycleObserver = Readonly<{
	started(): Promise<void>;
	completed(): Promise<void>;
}>;

type InteractiveModeWithInputLifecycle = InstanceType<typeof hostPi.InteractiveMode> & {
	observeInputLifecycle?: InputLifecycleObserver;
	observeCompactionQueuedInput?: (count: number) => void;
};

type InteractivePrototype = {
	getUserInput(this: InteractiveModeWithInputLifecycle): Promise<string>;
	queueCompactionMessage(
		this: InteractiveModeWithInputLifecycle,
		text: string,
		mode: "steer" | "followUp",
	): void;
	restoreQueuedMessagesToEditor(
		this: InteractiveModeWithInputLifecycle,
		options?: { abort?: boolean; currentText?: string },
	): number;
};

const PATCH_REGISTRY_KEY = "__piAgentCoordinationChildInteractiveInputPatch";
const globalPatchRegistry = globalThis as typeof globalThis & {
	[PATCH_REGISTRY_KEY]?: WeakSet<object>;
};
const patchedPrototypes = globalPatchRegistry[PATCH_REGISTRY_KEY] ??= new WeakSet();
const prototype = hostPi.InteractiveMode.prototype as unknown as InteractivePrototype;

if (!patchedPrototypes.has(prototype)) {
	patchedPrototypes.add(prototype);
	const originalGetUserInput = prototype.getUserInput;
	prototype.getUserInput = async function getObservedUserInput(
		this: InteractiveModeWithInputLifecycle,
	): Promise<string> {
		const input = await originalGetUserInput.call(this);
		const observer = this.observeInputLifecycle;
		if (!observer) return input;

		// Admit the input lifecycle before Pi can enter an inherited async preflight.
		await observer.started();
		const session = (this as unknown as { runtimeHost: hostPi.AgentSessionRuntime })
			.runtimeHost.session;
		const originalPrompt = session.prompt;
		let invoked = false;
		let inputCompleted = false;
		const completeInput = () => {
			if (inputCompleted) return Promise.resolve();
			inputCompleted = true;
			return observer.completed();
		};
		session.prompt = (text, options) => {
			if (!invoked) {
				invoked = true;
				session.prompt = originalPrompt;
			}
			let prompt: Promise<void>;
			try {
				prompt = originalPrompt.call(session, text, options);
			} catch (error) {
				void completeInput().catch(() => undefined);
				throw error;
			}
			void prompt.then(
				() => completeInput(),
				() => completeInput(),
			).catch(() => undefined);
			return prompt;
		};
		return input;
	};

	const originalQueueCompactionMessage = prototype.queueCompactionMessage;
	prototype.queueCompactionMessage = function queueObservedCompactionMessage(
		this: InteractiveModeWithInputLifecycle,
		text: string,
		mode: "steer" | "followUp",
	): void {
		originalQueueCompactionMessage.call(this, text, mode);
		const queued = (this as unknown as { compactionQueuedMessages: unknown[] })
			.compactionQueuedMessages.length;
		this.observeCompactionQueuedInput?.(queued);
	};

	const originalRestoreQueuedMessagesToEditor = prototype.restoreQueuedMessagesToEditor;
	prototype.restoreQueuedMessagesToEditor = function restoreObservedQueuesToEditor(
		this: InteractiveModeWithInputLifecycle,
		options?: { abort?: boolean; currentText?: string },
	): number {
		const restored = originalRestoreQueuedMessagesToEditor.call(this, options);
		if (restored > 0) this.observeCompactionQueuedInput?.(0);
		return restored;
	};
}
