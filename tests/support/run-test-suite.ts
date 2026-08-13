import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const FAST_TEST_CONCURRENCY = 4;
const PROCESS_TEST_CONCURRENCY = 1;

// These files launch real Pi processes, PTYs, sockets, or process-visible model
// brokers. Keeping the boundary explicit prevents machine CPU count from turning
// integration tests into a resource-contention lottery.
const PROCESS_TEST_FILES = new Set([
	"agent-request.test.ts",
	"agent-spawn.test.ts",
	"agent-view.test.ts",
	"cold-host-recovery.test.ts",
	"coordinated-workflow-pty.test.ts",
	"detached-child-ui-pty.test.ts",
	"execution-scheduler.test.ts",
	"human-request-pty.test.ts",
	"human-request.test.ts",
	"interactive-host-conformance.test.ts",
	"message.test.ts",
	"operational-incidents.test.ts",
	"owner-bootstrap.test.ts",
	"owner-fork.test.ts",
	"owner-workflow.test.ts",
	"pi-child-hosted-runtime.test.ts",
	"pi-child-process-launch.test.ts",
	"pi-child-process-runtime.test.ts",
	"process-child-session-factory.test.ts",
	"process-model-broker.test.ts",
	"process-visible-owner-model.test.ts",
	"pty-terminal-projection.test.ts",
	"run-supervision.test.ts",
	"unix-control-transport.test.ts",
]);

const suite = process.argv[2];
if (suite !== "fast" && suite !== "process") {
	throw new Error('Test suite must be "fast" or "process"');
}

const testsDirectory = fileURLToPath(new URL("..", import.meta.url));
const allTestFiles = readdirSync(testsDirectory)
	.filter((file) => file.endsWith(".test.ts"))
	.sort();
const missingProcessFiles = [...PROCESS_TEST_FILES]
	.filter((file) => !allTestFiles.includes(file));
if (missingProcessFiles.length > 0) {
	throw new Error(`Configured process tests do not exist: ${missingProcessFiles.join(", ")}`);
}

const selectedFiles = allTestFiles
	.filter((file) => PROCESS_TEST_FILES.has(file) === (suite === "process"))
	.map((file) => join(testsDirectory, file));
const forwardedArguments = process.argv.slice(3);
if (forwardedArguments.includes("--list")) {
	for (const file of selectedFiles) console.log(basename(file));
	process.exit(0);
}

const concurrency = suite === "fast"
	? FAST_TEST_CONCURRENCY
	: PROCESS_TEST_CONCURRENCY;
const result = spawnSync(process.execPath, [
	"--test",
	`--test-concurrency=${concurrency}`,
	"--test-reporter=dot",
	...forwardedArguments,
	...selectedFiles,
], { stdio: "inherit" });

if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
process.exitCode = result.status ?? 1;
