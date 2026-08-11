import { VERSION } from "@earendil-works/pi-coding-agent";
import {
	type TUI,
	type TuiInputListener,
} from "@earendil-works/pi-tui";

import {
	assertPrioritizedTuiInputListenerShape,
	IncompatiblePiHostError,
} from "./host-shape.ts";

/** Installs the Agent-view router ahead of Pi's normal physical input listeners. */
export function addPrioritizedTuiInputListener(
	tui: TUI,
	listener: TuiInputListener,
): () => void {
	assertPrioritizedTuiInputListenerShape(tui, VERSION);
	const listeners = tui.inputListeners as Set<TuiInputListener>;
	const removeListener = tui.addInputListener(listener);
	if (!listeners.delete(listener)) {
		removeListener();
		throw new IncompatiblePiHostError("TUI.inputListeners registration", VERSION);
	}
	const existingListeners = [...listeners];
	listeners.clear();
	listeners.add(listener);
	for (const existingListener of existingListeners) listeners.add(existingListener);
	let removed = false;
	return () => {
		if (removed) return;
		removed = true;
		removeListener();
		listeners.delete(listener);
	};
}
