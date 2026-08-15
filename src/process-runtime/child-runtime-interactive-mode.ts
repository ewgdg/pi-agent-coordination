import * as hostPi from "@earendil-works/pi-coding-agent";

type InputLifecycleObserver = Readonly<{
	started(): Promise<number>;
	completed(submissionSequence: number): Promise<void>;
}>;

type InteractivePrototype = {
	getUserInput(): Promise<string>;
};

type InputLifecycleBinding = Readonly<{
	session: hostPi.AgentSession;
	observer: InputLifecycleObserver;
}>;

type InputPatchState = {
	binding?: InputLifecycleBinding;
};

const PATCH_REGISTRY_KEY = "__piAgentCoordinationChildInteractiveInputPatch";
const globalPatchRegistry = globalThis as typeof globalThis & {
	[PATCH_REGISTRY_KEY]?: WeakMap<object, InputPatchState>;
};
const patchStates = globalPatchRegistry[PATCH_REGISTRY_KEY] ??= new WeakMap();
const prototype = hostPi.InteractiveMode.prototype as unknown as InteractivePrototype;
let state = patchStates.get(prototype);
if (!state) {
	const installedState: InputPatchState = {};
	installInputLifecyclePatch(prototype, installedState);
	patchStates.set(prototype, installedState);
	state = installedState;
}
const inputPatchState = state;

/** Bind the one child process's interactive loop to its already captured public session. */
export function bindChildInteractiveInputLifecycle(
	session: hostPi.AgentSession,
	observer: InputLifecycleObserver,
): () => void {
	const binding = { session, observer };
	inputPatchState.binding = binding;
	return () => {
		if (inputPatchState.binding === binding) inputPatchState.binding = undefined;
	};
}

function installInputLifecyclePatch(
	interactivePrototype: InteractivePrototype,
	patchState: InputPatchState,
): void {
	const originalGetUserInput = interactivePrototype.getUserInput;
	interactivePrototype.getUserInput = async function getObservedUserInput(): Promise<string> {
		const input = await originalGetUserInput.call(this);
		const binding = patchState.binding;
		if (!binding) return input;

		// Admit the input lifecycle before Pi can enter an inherited async preflight.
		const submissionSequence = await binding.observer.started();
		const { session, observer } = binding;
		const originalPrompt = session.prompt;
		let invoked = false;
		let inputCompleted = false;
		const completeInput = () => {
			if (inputCompleted) return Promise.resolve();
			inputCompleted = true;
			return observer.completed(submissionSequence);
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
}
