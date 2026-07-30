import { emitKeypressEvents } from "node:readline";

import { createPrototypePiRuntime } from "./deterministic-pi-runtime.ts";
import {
	SerializedAgentHost,
	type HostSnapshot,
} from "./serialized-agent-host.ts";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const CLEAR = "\x1b[2J\x1b[H";

const SCENARIOS = {
	message: "Dormant Message restart",
	"close-first": "Close-first race",
	"delivery-first": "Delivery-first race",
	retry: "Request retry",
	spawn: "Dynamic spawn",
	"spawn-result": "Dynamic spawn + result",
} as const;

type ScenarioName = keyof typeof SCENARIOS;

const { modelRuntime, model } = await createPrototypePiRuntime();
const host = new SerializedAgentHost(modelRuntime, model);
const requestedScenario = parseScenarioArgument(process.argv.slice(2));

if (requestedScenario) {
	await runScripted(requestedScenario);
	await host.shutdown();
} else {
	await runInteractive();
}

async function runScripted(scenario: ScenarioName | "all"): Promise<void> {
	const names = scenario === "all"
		? (Object.keys(SCENARIOS) as ScenarioName[])
		: [scenario];
	for (const name of names) {
		await runScenario(name);
		process.stdout.write(`${renderSnapshot(host.snapshot(), false)}\n\n`);
	}
}

async function runInteractive(): Promise<void> {
	if (!process.stdin.isTTY) {
		throw new Error("Interactive mode needs a TTY; use --scenario all for a scripted drive-through");
	}

	emitKeypressEvents(process.stdin);
	process.stdin.setRawMode(true);
	process.stdin.resume();
	let busy = false;
	let errorMessage: string | undefined;

	const render = (): void => {
		process.stdout.write(CLEAR);
		process.stdout.write(renderSnapshot(host.snapshot(), true));
		if (busy) process.stdout.write(`\n${BOLD}Running scenario…${RESET}\n`);
		if (errorMessage) process.stdout.write(`\n${BOLD}Error:${RESET} ${errorMessage}\n`);
		process.stdout.write(
			`\n${BOLD}[m]${RESET} ${DIM}dormant Message${RESET}  ` +
			`${BOLD}[c]${RESET} ${DIM}close first${RESET}  ` +
			`${BOLD}[d]${RESET} ${DIM}delivery first${RESET}  ` +
			`${BOLD}[r]${RESET} ${DIM}Request retry${RESET}\n` +
			`${BOLD}[s]${RESET} ${DIM}dynamic spawn${RESET}  ` +
			`${BOLD}[a]${RESET} ${DIM}answer spawned Request${RESET}  ` +
			`${BOLD}[0]${RESET} ${DIM}reset${RESET}  ` +
			`${BOLD}[q]${RESET} ${DIM}quit${RESET}\n`,
		);
	};

	const quit = async (): Promise<void> => {
		process.stdin.setRawMode(false);
		process.stdin.pause();
		await host.shutdown();
		process.stdout.write(`${CLEAR}Prototype closed.\n`);
	};

	render();
	process.stdin.on("keypress", (_input, key) => {
		if (busy) return;
		if (key.ctrl && key.name === "c" || key.name === "q") {
			busy = true;
			void quit();
			return;
		}

		const action = actionForKey(key.name);
		if (!action) return;
		busy = true;
		errorMessage = undefined;
		render();
		void action()
			.catch((error: unknown) => {
				errorMessage = error instanceof Error ? error.message : String(error);
			})
			.finally(() => {
				busy = false;
				render();
			});
	});

	function actionForKey(key: string | undefined): (() => Promise<void>) | undefined {
		switch (key) {
			case "m": return () => runScenario("message");
			case "c": return () => runScenario("close-first");
			case "d": return () => runScenario("delivery-first");
			case "r": return () => runScenario("retry");
			case "s": return () => runScenario("spawn");
			case "a": return () => host.answerLatestSpawnRequest();
			case "0": return () => host.reset();
			default: return undefined;
		}
	}
}

async function runScenario(name: ScenarioName): Promise<void> {
	switch (name) {
		case "message":
			await host.demonstrateDormantDelivery();
			break;
		case "close-first":
			await host.demonstrateCloseRace("close_first");
			break;
		case "delivery-first":
			await host.demonstrateCloseRace("delivery_first");
			break;
		case "retry":
			await host.demonstrateRequestRetry();
			break;
		case "spawn":
			await host.demonstrateDynamicSpawn();
			break;
		case "spawn-result":
			await host.demonstrateDynamicSpawn();
			await host.answerLatestSpawnRequest();
			break;
	}
}

function renderSnapshot(snapshot: HostSnapshot, ansi: boolean): string {
	const bold = ansi ? BOLD : "";
	const dim = ansi ? DIM : "";
	const reset = ansi ? RESET : "";
	const lines = [
		`${bold}PROTOTYPE — serialized in-process Pi Agent Runs${reset}`,
		`${dim}${snapshot.scenario}${reset}`,
		"",
		`${bold}Agents${reset}`,
	];

	if (snapshot.agents.length === 0) lines.push("  —");
	for (const agent of snapshot.agents) {
		lines.push(
			`  ${bold}${agent.name}${reset} · ${agent.agentId} · spawner ${agent.directSpawner}`,
			`    Run: ${agent.run} · work ${agent.work} · started ${agent.runsStarted} · disposed ${agent.runsDisposed}`,
			`    Blockers: ${agent.blockers.length > 0 ? agent.blockers.join("; ") : "none"}`,
			`    Evidence: outbound ${agent.outboundEvidence} · delivery ${agent.deliveryEvidence} · retry ${agent.retryEvidence}`,
		);
	}

	lines.push("", `${bold}Messages${reset}`);
	if (snapshot.messages.length === 0) lines.push("  —");
	for (const message of snapshot.messages) {
		lines.push(
			`  ${message.messageId} · ${message.kind} · ${message.from} → ${message.to} · recipient commits ${message.deliveries}`,
		);
	}

	lines.push("", `${bold}Serialized trace${reset}`);
	if (snapshot.trace.length === 0) lines.push("  —");
	for (const event of snapshot.trace) lines.push(`  ${dim}${event}${reset}`);
	return lines.join("\n");
}

function parseScenarioArgument(arguments_: string[]): ScenarioName | "all" | undefined {
	const index = arguments_.indexOf("--scenario");
	if (index === -1) return undefined;
	const value = arguments_[index + 1];
	if (value === "all") return value;
	if (value && value in SCENARIOS) return value as ScenarioName;
	throw new Error(`Unknown scenario ${value ?? "(missing)"}; use ${Object.keys(SCENARIOS).join(", ")}, or all`);
}
