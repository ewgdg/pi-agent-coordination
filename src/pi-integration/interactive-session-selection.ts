import type {
	AgentSession,
	AgentSessionRuntime,
	AgentSessionRuntimeDiagnostic,
	AgentSessionServices,
} from "@earendil-works/pi-coding-agent";

import {
	attachNativeExtensionUIContext,
	readNativeExtensionUIState,
	reinstallDetachedExtensionUIContext,
	restoreNativeExtensionUIState,
} from "./extension-bindings.ts";
import { SerialLane } from "../runtime/serial-lane.ts";

export type HumanPresentationBinding = Readonly<{
	agentId: string;
	session: AgentSession;
	services: AgentSessionServices;
	diagnostics: readonly AgentSessionRuntimeDiagnostic[];
	release?(): void | Promise<void>;
}>;

type PresentationReplacementOptions = Readonly<{
	expectedSession?: AgentSession;
	previousBindingDisposition?: "retained" | "disposing";
}>;

export type HumanSessionSelection = Readonly<{
	selectedAgentId(): string;
	addChangeHandler(handler: () => void): () => void;
	activate(binding: HumanPresentationBinding): Promise<void>;
	restoreOwnerRuntimeForShutdown(): Promise<void>;
	isBoundTo(agentId: string, session: AgentSession): boolean;
	replaceIfSelected(
		agentId: string,
		binding: HumanPresentationBinding,
		options?: PresentationReplacementOptions,
	): Promise<boolean>;
}>;

type MutableRuntimeState = {
	_session: AgentSession;
	_services: AgentSessionServices;
	_diagnostics: AgentSessionRuntimeDiagnostic[];
	beforeSessionInvalidate?: () => void;
	rebindSession?: (session: AgentSession) => Promise<void>;
};

export function bindHumanSessionSelection(
	runtime: AgentSessionRuntime,
	ownerAgentId: string,
): HumanSessionSelection {
	const mutableRuntime = runtime as unknown as MutableRuntimeState;
	const lane = new SerialLane();
	const owner: HumanPresentationBinding = {
		agentId: ownerAgentId,
		session: runtime.session,
		services: runtime.services,
		diagnostics: runtime.diagnostics,
	};
	let selected = owner;
	let selectedNativeBindingConfirmed = true;
	const changeHandlers = new Set<() => void>();
	const notifySelectionChanged = (): void => {
		for (const handler of changeHandlers) handler();
	};
	const applyRuntimeBinding = (binding: HumanPresentationBinding): void => {
		mutableRuntime._session = binding.session;
		mutableRuntime._services = binding.services;
		mutableRuntime._diagnostics = [...binding.diagnostics];
	};
	const releaseIfNotSelected = async (
		binding: HumanPresentationBinding,
	): Promise<void> => {
		if (binding.session === selected.session) return;
		await binding.release?.();
	};
	const activateInLane = async (binding: HumanPresentationBinding): Promise<void> => {
		if (
			binding.agentId === selected.agentId &&
			binding.session === selected.session &&
			selectedNativeBindingConfirmed
		) return;
		const rebindSession = mutableRuntime.rebindSession;
		if (!rebindSession) {
			throw new Error("Pi InteractiveMode has not registered its session rebind callback");
		}
		const previous = selected;
		// Native teardown clears the shared TUI extension state. Read each session's
		// last binding before teardown and restore only after the target is rebound;
		// replaying session_start would duplicate non-UI extension lifecycle work.
		const previousExtensionUIState = readNativeExtensionUIState(previous.session);
		const nextExtensionUIState = readNativeExtensionUIState(binding.session);
		// Pi normally performs this synchronous teardown immediately before session
		// replacement. Retained and presentation-only bindings need the same UI seam.
		mutableRuntime.beforeSessionInvalidate?.();
		applyRuntimeBinding(binding);
		try {
			await rebindSession(binding.session);
			restoreNativeExtensionUIState(binding.session, nextExtensionUIState);
			// A deselected session must not keep the TUI-bound context from its
			// own presentation: its later UI calls would land in the newly
			// selected Agent's view. Children fall back to their detached context;
			// the Owner keeps its native one. Same-session re-activation keeps
			// its freshly rebound native context.
			if (
				previous.session !== binding.session &&
				previous.agentId !== owner.agentId
			) {
				reinstallDetachedExtensionUIContext(previous.session);
			}
		} catch (activationError) {
			const rollbackErrors: unknown[] = [];
			try {
				mutableRuntime.beforeSessionInvalidate?.();
			} catch (rollbackError) {
				rollbackErrors.push(rollbackError);
			}
			applyRuntimeBinding(previous);
			try {
				await rebindSession(previous.session);
				restoreNativeExtensionUIState(previous.session, previousExtensionUIState);
			} catch (rollbackError) {
				rollbackErrors.push(rollbackError);
			}
			selectedNativeBindingConfirmed = rollbackErrors.length === 0;
			if (rollbackErrors.length > 0) {
				throw new AggregateError(
					[activationError, ...rollbackErrors],
					"Pi Interactive Selection activation and rollback failed",
				);
			}
			throw activationError;
		}
		selected = binding;
		selectedNativeBindingConfirmed = true;
		notifySelectionChanged();
		try {
			if (previous.session !== binding.session) await previous.release?.();
		} catch (error) {
			// Rebinding is already committed. A previous presentation cleanup failure
			// must not invalidate the newly selected session beneath Pi's editor.
			mutableRuntime._diagnostics.push({
				type: "error",
				message: `Previous Interactive Selection binding cleanup failed: ${
					error instanceof Error ? error.message : String(error)
				}`,
			});
		}
	};
	const commitReplacementBeforeDispose = async (
		binding: HumanPresentationBinding,
		activationError: unknown,
	): Promise<void> => {
		const previous = selected;
		const recoveryErrors: unknown[] = [activationError];
		const nextExtensionUIState = readNativeExtensionUIState(binding.session);
		let replacementConfirmed = true;
		// Rollback cannot remain the final state because the previous exact Run
		// will be disposed immediately after this transition completes.
		try {
			mutableRuntime.beforeSessionInvalidate?.();
		} catch (error) {
			recoveryErrors.push(error);
			replacementConfirmed = false;
		}
		applyRuntimeBinding(binding);
		const rebindSession = mutableRuntime.rebindSession;
		const degradeSelectedPresentation = (): void => {
			// The presentation is the selected session even when its native rebind
			// failed; its UI calls belong in the Owner's TUI, and a detached
			// context would leave its surfaces inert.
			attachNativeExtensionUIContext(binding.session, owner.session);
		};
		if (!rebindSession) {
			replacementConfirmed = false;
			degradeSelectedPresentation();
		} else {
			try {
				await rebindSession(binding.session);
				restoreNativeExtensionUIState(binding.session, nextExtensionUIState);
			} catch (error) {
				recoveryErrors.push(error);
				replacementConfirmed = false;
				degradeSelectedPresentation();
			}
		}
		selected = binding;
		selectedNativeBindingConfirmed = replacementConfirmed;
		notifySelectionChanged();
		try {
			if (previous.session !== binding.session) await previous.release?.();
		} catch (error) {
			recoveryErrors.push(error);
		}
		mutableRuntime._diagnostics.push({
			type: "error",
			message: `Interactive Selection detached from an ending Run after native rebinding failed: ${
				recoveryErrors.map((error) =>
					error instanceof Error ? error.message : String(error)
				).join("; ")
			}`,
		});
	};
	return {
		selectedAgentId: () => selected.agentId,
		addChangeHandler: (handler) => {
			changeHandlers.add(handler);
			return () => changeHandlers.delete(handler);
		},
		activate: (binding) => lane.run(async () => {
			try {
				await activateInLane(binding);
			} catch (activationError) {
				try {
					await releaseIfNotSelected(binding);
				} catch (cleanupError) {
					throw new AggregateError(
						[activationError, cleanupError],
						"Interactive Selection activation and cleanup failed",
					);
				}
				throw activationError;
			}
		}),
		restoreOwnerRuntimeForShutdown: () => lane.run(async () => {
			if (selected.agentId === owner.agentId && selected.session === owner.session) return;
			const previous = selected;
			// Native disposal requires Owner runtime state, not a presentation change.
			// Interactive quit has stopped the TUI; signal shutdown is about to stop it.
			applyRuntimeBinding(owner);
			selected = owner;
			selectedNativeBindingConfirmed = false;
			await previous.release?.();
		}),
		isBoundTo: (agentId, session) =>
			selectedNativeBindingConfirmed &&
			selected.agentId === agentId && selected.session === session,
		replaceIfSelected: (
			agentId,
			binding,
			options,
		) => lane.run(async () => {
			if (
				selected.agentId !== agentId ||
				(options?.expectedSession !== undefined &&
					selected.session !== options.expectedSession)
			) {
				await releaseIfNotSelected(binding);
				return false;
			}
			try {
				await activateInLane(binding);
			} catch (activationError) {
				if (options?.previousBindingDisposition === "disposing") {
					await commitReplacementBeforeDispose(binding, activationError);
					return true;
				}
				try {
					await releaseIfNotSelected(binding);
				} catch (cleanupError) {
					throw new AggregateError(
						[activationError, cleanupError],
						"Interactive Selection replacement and cleanup failed",
					);
				}
				throw activationError;
			}
			return true;
		}),
	};
}
