import * as hostAi from "@earendil-works/pi-ai";
import * as hostPi from "@earendil-works/pi-coding-agent";
import * as hostTui from "@earendil-works/pi-tui";
import * as hostTypebox from "typebox";
import type {
	ExtensionFactory,
	ExtensionHandler,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

import { initializeOwnerWorkflow } from "./bootstrap/owner-bootstrap.ts";
import type { OrdinaryAgentCoordinatorView } from "./coordination/workflow-coordinator.ts";
import {
	assertExtensionApiShape,
	assertHostModuleShape,
	assertPiAiModuleShape,
	assertTuiModuleShape,
	assertTypeboxModuleShape,
} from "./pi-integration/host-shape.ts";
import { installInteractiveHostBridge } from "./pi-integration/interactive-host-bridge.ts";
import {
	activateOwnerAgentTools,
	deactivateOwnerAgentTools,
	registerOwnerAgentTools,
} from "./tools/owner-surfaces.ts";

const ENTRY_MODULE_PATH = import.meta.filename;

const piAgentCoordination: ExtensionFactory = (pi) => {
	assertExtensionApiShape(pi);
	assertHostModuleShape(hostPi);
	assertPiAiModuleShape(hostAi, hostPi.VERSION);
	assertTuiModuleShape(hostTui, hostPi.VERSION);
	assertTypeboxModuleShape(hostTypebox, hostPi.VERSION);
	const bridge = installInteractiveHostBridge(hostPi);
	let currentWorkflowOwnerAdmitted = false;
	let resolveOwnerView: (() => OrdinaryAgentCoordinatorView) | undefined;
	let settleOwnerAdmission: () => void = () => {};
	const ownerAdmissionSettled = new Promise<void>((resolve) => {
		settleOwnerAdmission = resolve;
	});
	// An earlier extension can launch fire-and-forget model work from session_start.
	// Hold that turn until this exact Owner admission has either succeeded or failed.
	pi.on("before_agent_start", () => ownerAdmissionSettled);
	// Pi reconstructs replacement transcripts before session_start. Register the
	// official tool definitions now so historical calls receive their renderers.
	registerOwnerAgentTools(pi, () => {
		if (!resolveOwnerView) {
			throw new Error("Owner Workflow is not admitted");
		}
		return resolveOwnerView();
	});

	const bootstrapOwner: ExtensionHandler<SessionStartEvent> = async (event, ctx) => {
		deactivateOwnerAgentTools(pi);
		try {
			if (ctx.mode !== "tui" || !ctx.hasUI) return;
			resolveOwnerView = await initializeOwnerWorkflow({
				pi,
				ctx,
				bridge,
				entryModulePath: ENTRY_MODULE_PATH,
				bootstrapHandler: bootstrapOwner,
				event,
			});
			activateOwnerAgentTools(pi);
			currentWorkflowOwnerAdmitted = true;
		} catch (error) {
			deactivateOwnerAgentTools(pi);
			throw error;
		} finally {
			settleOwnerAdmission();
		}
	};
	pi.on("session_start", bootstrapOwner);
	pi.on("session_before_fork", (_event, ctx) => {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		return currentWorkflowOwnerAdmitted ? undefined : { cancel: true };
	});
	pi.on("session_before_switch", (_event, ctx) => {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		return currentWorkflowOwnerAdmitted ? undefined : { cancel: true };
	});
};

export {
	PiChildProcessRuntime,
	resolveInstalledPiCliPath,
	type PiChildRuntimeChannel,
	type PiChildRuntimeEvent,
	type PiChildRuntimeReady,
	type PiChildRuntimeSnapshot,
	type StartPiChildProcessRuntimeOptions,
} from "./process-runtime/pi-child-process-runtime.ts";

export default piAgentCoordination;
