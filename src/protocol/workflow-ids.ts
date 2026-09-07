import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const ALLOCATION_LOCK_TIMEOUT_MS = 5_000;

/** Commit the counter and canonical source assignment together, before publishing an ID. */
export function allocateWorkflowId(options: {
	workflowId: string;
	domain: "a" | "m";
	source: string;
	directory?: string;
}): string {
	const { workflowId, domain, source } = options;
	if (!workflowId || !source) throw new Error("Identity allocation requires Workflow and source");
	const directory = options.directory ?? join(getAgentDir(), "pi-agent-coordination");
	mkdirSync(directory, { recursive: true });
	const database = new DatabaseSync(join(directory, "identities.sqlite"), {
		timeout: ALLOCATION_LOCK_TIMEOUT_MS,
	});
	try {
		database.exec(`
			CREATE TABLE IF NOT EXISTS counters (
				workflow TEXT NOT NULL, domain TEXT NOT NULL, value TEXT NOT NULL,
				PRIMARY KEY (workflow, domain)
			);
			CREATE TABLE IF NOT EXISTS assignments (
				workflow TEXT NOT NULL, domain TEXT NOT NULL, source TEXT NOT NULL, id TEXT NOT NULL,
				PRIMARY KEY (workflow, domain, source), UNIQUE (workflow, domain, id)
			);
			BEGIN IMMEDIATE;
		`);
		const assigned = database.prepare(
			"SELECT id FROM assignments WHERE workflow = ? AND domain = ? AND source = ?",
		).get(workflowId, domain, source);
		if (assigned) {
			database.exec("COMMIT");
			return assigned.id as string;
		}
		const counter = database.prepare(
			"SELECT value FROM counters WHERE workflow = ? AND domain = ?",
		).get(workflowId, domain);
		// Decimal text avoids SQLite's signed 64-bit and JavaScript's Number limits.
		const next = (BigInt(counter?.value as string ?? "0") + 1n).toString();
		const id = `${domain}${next}`;
		database.prepare(`INSERT INTO counters VALUES (?, ?, ?)
			ON CONFLICT (workflow, domain) DO UPDATE SET value = excluded.value`).run(workflowId, domain, next);
		database.prepare("INSERT INTO assignments VALUES (?, ?, ?, ?)").run(workflowId, domain, source, id);
		database.exec("COMMIT");
		return id;
	} finally {
		// Closing an interrupted transaction rolls it back and releases the OS lock.
		database.close();
	}
}
