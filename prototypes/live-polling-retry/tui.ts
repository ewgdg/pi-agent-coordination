// PROTOTYPE — throwaway terminal shell for driving the live-retry model.

import { emitKeypressEvents } from "node:readline";
import {
  initialState,
  PROTOTYPE_MESSAGE,
  reducePrototype,
  type PrototypeAction,
  type PrototypeState,
} from "./model.ts";

const bold = "\x1b[1m";
const dim = "\x1b[2m";
const reset = "\x1b[0m";

let state = initialState();

const renderSection = (title: string, value: unknown): string =>
  `${bold}${title}${reset}\n${JSON.stringify(value, null, 2)}`;

const render = (current: PrototypeState): void => {
  console.clear();
  console.log(`${bold}PROTOTYPE — volatile live delivery${reset}`);
  console.log(
    `${dim}${PROTOTYPE_MESSAGE.senderAgentId} → ${PROTOTYPE_MESSAGE.recipientAgentId}${reset}\n`,
  );
  console.log(renderSection("Last action", current.lastAction));
  console.log();
  console.log(renderSection("Volatile scheduler", current.volatileScheduler));
  console.log();
  console.log(renderSection("Last sender poll", current.lastPoll));
  console.log();
  console.log(renderSection("Sender transcript", current.senderTranscript));
  console.log();
  console.log(renderSection("Recipient transcript", current.recipientTranscript));
  console.log();
  console.log(
    `${bold}[s]${reset}${dim} send${reset}  ` +
      `${bold}[d]${reset}${dim} deliver${reset}  ` +
      `${bold}[x]${reset}${dim} crash recipient${reset}  ` +
      `${bold}[u]${reset}${dim} restart recipient${reset}  ` +
      `${bold}[p]${reset}${dim} poll${reset}  ` +
      `${bold}[r]${reset}${dim} retry same identity${reset}  ` +
      `${bold}[0]${reset}${dim} reset${reset}  ` +
      `${bold}[q]${reset}${dim} quit${reset}`,
  );
};

const actions: Record<string, PrototypeAction> = {
  s: { type: "send" },
  d: { type: "deliver" },
  x: { type: "crash-recipient" },
  u: { type: "restart-recipient" },
  p: { type: "poll" },
  r: { type: "retry" },
  "0": { type: "reset" },
};

emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}
process.stdin.resume();
process.stdin.setEncoding("utf8");

render(state);
process.stdin.on("keypress", (_input, key) => {
  if (key.ctrl && key.name === "c" || key.name === "q") {
    console.clear();
    process.exit(0);
  }

  const action = actions[key.name ?? ""];
  if (!action) return;

  state = reducePrototype(state, action);
  render(state);
});
