import * as hostPi from "@earendil-works/pi-coding-agent";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

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

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		await initializeOwnerWorkflow({ pi, ctx, bridge, entryModulePath: ENTRY_MODULE_PATH });
	});
};

export default piAgentCoordination;
