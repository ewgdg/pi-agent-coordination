import { isAbsolute } from "node:path";

export const CHILD_PROCESS_BOOTSTRAP_ENVIRONMENT_VARIABLE =
	"PI_AGENT_COORDINATION_BOOTSTRAP";

const PHYSICAL_HERDR_OWNERSHIP_VARIABLES = new Set([
	"HERDR_ENV",
	"HERDR_SOCKET_PATH",
	"HERDR_PANE_ID",
]);

export function buildChildProcessEnvironment(options: {
	ownerEnvironment: NodeJS.ProcessEnv;
	bootstrapPath: string;
}): Record<string, string> {
	if (!isAbsolute(options.bootstrapPath) || options.bootstrapPath.includes("\0")) {
		throw new Error("invalid_child_environment: bootstrap path must be absolute");
	}
	const environment = Object.fromEntries(
		Object.entries(options.ownerEnvironment).filter(
			(entry): entry is [string, string] =>
				entry[1] !== undefined &&
				!PHYSICAL_HERDR_OWNERSHIP_VARIABLES.has(entry[0]),
		),
	);
	environment[CHILD_PROCESS_BOOTSTRAP_ENVIRONMENT_VARIABLE] =
		options.bootstrapPath;
	return environment;
}
