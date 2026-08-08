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
import {
	assertExtensionApiShape,
	assertHostModuleShape,
	assertPiAiModuleShape,
	assertTuiModuleShape,
	assertTypeboxModuleShape,
} from "./pi-integration/host-shape.ts";
import { installInteractiveHostBridge } from "./pi-integration/interactive-host-bridge.ts";

const ENTRY_MODULE_PATH = import.meta.filename;

const piAgentCoordination: ExtensionFactory = (pi) => {
	assertExtensionApiShape(pi);
	assertHostModuleShape(hostPi);
	assertPiAiModuleShape(hostAi, hostPi.VERSION);
	assertTuiModuleShape(hostTui, hostPi.VERSION);
	assertTypeboxModuleShape(hostTypebox, hostPi.VERSION);
	const bridge = installInteractiveHostBridge(hostPi);
	let currentWorkflowOwnerAdmitted = false;

	const bootstrapOwner: ExtensionHandler<SessionStartEvent> = async (event, ctx) => {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		await initializeOwnerWorkflow({
			pi,
			ctx,
			bridge,
			entryModulePath: ENTRY_MODULE_PATH,
			bootstrapHandler: bootstrapOwner,
			event,
			hostModule: hostPi,
		});
		currentWorkflowOwnerAdmitted = true;
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

export default piAgentCoordination;
