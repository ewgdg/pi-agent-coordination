import { randomUUID } from "node:crypto";

export const DETACHED_FRAME_BARRIER_OSC = 777;
export const DETACHED_FRAME_BARRIER_PREFIX = "pi-agent-coordination:detached-frame:";

export function createTerminalPresentationBarrierMarker(): string {
	return randomUUID();
}

export function terminalPresentationBarrierData(marker: string): string {
	return `${DETACHED_FRAME_BARRIER_PREFIX}${marker}`;
}

export function terminalPresentationBarrierSequence(marker: string): string {
	return `\x1b]${DETACHED_FRAME_BARRIER_OSC};${terminalPresentationBarrierData(marker)}\x1b\\`;
}
