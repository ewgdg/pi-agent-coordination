import assert from "node:assert/strict";
import test from "node:test";

import {
	CHILD_PROCESS_BOOTSTRAP_ENVIRONMENT_VARIABLE,
	buildChildProcessEnvironment,
} from "../src/process-runtime/child-process-environment.ts";

test("child process inherits ordinary runtime configuration without physical Herdr pane ownership", () => {
	const ownerEnvironment: NodeJS.ProcessEnv = {
		HOME: "/home/test",
		PATH: "/bin",
		ANTHROPIC_API_KEY: "provider-secret",
		HERDR_ENV: "1",
		HERDR_SOCKET_PATH: "/runtime/herdr.sock",
		HERDR_PANE_ID: "pane-owner",
		UNDEFINED_VALUE: undefined,
	};

	const childEnvironment = buildChildProcessEnvironment({
		ownerEnvironment,
		bootstrapPath: "/runtime/workflow/child-bootstrap.json",
	});

	assert.deepEqual(childEnvironment, {
		HOME: "/home/test",
		PATH: "/bin",
		ANTHROPIC_API_KEY: "provider-secret",
		[CHILD_PROCESS_BOOTSTRAP_ENVIRONMENT_VARIABLE]:
			"/runtime/workflow/child-bootstrap.json",
	});
	assert.equal(ownerEnvironment.HERDR_PANE_ID, "pane-owner");
});

test("child process bootstrap path must be absolute", () => {
	assert.throws(
		() => buildChildProcessEnvironment({
			ownerEnvironment: {},
			bootstrapPath: "relative-bootstrap.json",
		}),
		/absolute/,
	);
});
