import {
	ProjectTrustStore,
	type DefaultProjectTrust,
	type LoadExtensionsResult,
	type ProjectTrustContext,
	type ProjectTrustHandler,
} from "@earendil-works/pi-coding-agent";

export type ProjectTrustResolution = Readonly<{
	trusted: boolean;
	diagnostics: readonly string[];
}>;

export async function resolveAgentRunProjectTrust(options: {
	cwd: string;
	agentDir: string;
	defaultProjectTrust: DefaultProjectTrust;
	extensionsResult: LoadExtensionsResult;
}): Promise<ProjectTrustResolution> {
	const diagnostics: string[] = [];
	const trustStore = new ProjectTrustStore(options.agentDir);
	const context = createNonInteractiveTrustContext(options.cwd);
	for (const extension of options.extensionsResult.extensions) {
		const handlers = extension.handlers.get("project_trust") as
			| ProjectTrustHandler[]
			| undefined;
		for (const handler of handlers ?? []) {
			try {
				const result = await handler(
					{ type: "project_trust", cwd: options.cwd },
					context,
				);
				if (result.trusted === "undecided") continue;
				const trusted = result.trusted === "yes";
				if (result.remember === true) trustStore.set(options.cwd, trusted);
				return { trusted, diagnostics };
			} catch (error) {
				diagnostics.push(
					`Extension ${JSON.stringify(extension.path)} project_trust error: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		}
	}

	const storedDecision = trustStore.get(options.cwd);
	if (storedDecision !== null) return { trusted: storedDecision, diagnostics };
	if (options.defaultProjectTrust === "always") return { trusted: true, diagnostics };
	return { trusted: false, diagnostics };
}

function createNonInteractiveTrustContext(cwd: string): ProjectTrustContext {
	return {
		cwd,
		mode: "tui",
		// Agent Run preflight must not seize the human UI. With an unresolved "ask"
		// policy, this follows Pi's no-UI behavior and leaves the project untrusted.
		hasUI: false,
		ui: {
			select: async () => undefined,
			confirm: async () => false,
			input: async () => undefined,
			notify() {},
		},
	};
}
