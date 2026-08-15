import { readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SUPERVISOR_CHECK_INTERVAL_MS = 25;
const CLEANUP_POLL_INTERVAL_MS = 5;
const sleepState = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
const supervisor = {
	pid: Number(process.env.PI_TEST_SUPERVISOR_PID),
	startTime: process.env.PI_TEST_SUPERVISOR_START_TIME,
};
const cgroupPath = process.env.PI_TEST_CGROUP_PATH;

if (
	!Number.isSafeInteger(supervisor.pid) ||
	supervisor.pid <= 1 ||
	!supervisor.startTime ||
	!cgroupPath?.startsWith("/sys/fs/cgroup/")
) {
	throw new Error("Test process guardian configuration is invalid");
}

let released = false;
process.on("message", (message) => {
	if (message !== "release") return;
	released = true;
	process.exit(0);
});
process.on("disconnect", () => {
	if (!released) terminateOwnedCgroup();
});
const check = setInterval(() => {
	if (sameProcess(supervisor.pid, supervisor.startTime!)) return;
	terminateOwnedCgroup();
}, SUPERVISOR_CHECK_INTERVAL_MS);
check.unref();
process.send?.("ready");

function terminateOwnedCgroup(): never {
	try {
		writeFileSync(join(cgroupPath!, "cgroup.kill"), "1");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const deadline = Date.now() + 1_000;
	while (Date.now() < deadline && cgroupIsPopulated(cgroupPath!)) {
		// This guardian is outside the owned cgroup, so cleanup remains available
		// even when the test runner is CPU-blocked or stopped.
		Atomics.wait(sleepState, 0, 0, CLEANUP_POLL_INTERVAL_MS);
	}
	try {
		rmdirSync(cgroupPath!);
	} catch (error) {
		if (!["EBUSY", "ENOENT", "ENOTEMPTY"].includes(
			(error as NodeJS.ErrnoException).code ?? "",
		)) throw error;
	}
	process.exit(0);
}

function sameProcess(pid: number, startTime: string): boolean {
	try {
		const fields = statFields(pid);
		return fields[19] === startTime && fields[0] !== "Z";
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

function cgroupIsPopulated(path: string): boolean {
	try {
		return readFileSync(join(path, "cgroup.events"), "utf8")
			.split("\n")
			.some((line) => line === "populated 1");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

function statFields(pid: number): string[] {
	const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
	return stat.slice(stat.lastIndexOf(")") + 2).trim().split(" ");
}
