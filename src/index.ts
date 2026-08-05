import * as hostPi from "@earendil-works/pi-coding-agent";
import type {
	ExtensionFactory,
	ExtensionHandler,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

import { initializeOwnerWorkflow } from "./bootstrap/owner-bootstrap.ts";
import {
	assertExtensionApiShape,
	assertHostModuleShape,
} from "./pi-integration/host-shape.ts";
import { installInteractiveHostBridge } from "./pi-integration/interactive-host-bridge.ts";

const ENTRY_MODULE_PATH = import.meta.filename;

const piAgentCoordination: ExtensionFactory = (pi) => {
	assertExtensionApiShape(pi);
	assertHostModuleShape(hostPi);
	const bridge = installInteractiveHostBridge(hostPi);

	const bootstrapOwner: ExtensionHandler<SessionStartEvent> = async (_event, ctx) => {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		await initializeOwnerWorkflow({
			pi,
			ctx,
			bridge,
			entryModulePath: ENTRY_MODULE_PATH,
			bootstrapHandler: bootstrapOwner,
		});
	};
	pi.on("session_start", bootstrapOwner);
};

export default piAgentCoordination;
