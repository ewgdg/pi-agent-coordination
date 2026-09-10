import { writeFileSync } from "node:fs";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";

type Stats = {
  pid: number;
  renderCalls: number;
  firstRenderAt?: number;
  lastRenderAt?: number;
};

/**
 * Benchmark-only native component. Its render method is the measurement point:
 * a stopped native Pi TUI cannot invoke it, while an attached TUI continues to
 * render the visible frame. Stats are written by the child, not inferred from
 * PTY bytes or the parent projection.
 */
class RenderProbe implements Component {
  readonly #stats: Stats;
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
    this.#stats = { pid: process.pid, renderCalls: 0 };
    this.#persist();
  }

  render(width: number): string[] {
    const now = Date.now();
    this.#stats.renderCalls += 1;
    this.#stats.firstRenderAt ??= now;
    this.#stats.lastRenderAt = now;
    this.#persist();
    return [truncateToWidth(
      `native-render-probe width=${width} calls=${this.#stats.renderCalls}`,
      Math.max(0, width),
      "",
    )];
  }

  invalidate(): void {}

  #persist(): void {
    writeFileSync(this.#path, `${JSON.stringify(this.#stats)}\n`, "utf8");
  }
}

const extension: ExtensionFactory = (pi) => {
  const path = process.env.PI_VISIBILITY_BENCHMARK_STATS;
  if (!path) return;
  pi.on("session_start", (_event, ctx) => {
    const probe = new RenderProbe(path);
    ctx.ui.setWidget("visibility-benchmark-render-probe", () => probe, {
      placement: "aboveEditor",
    });
  });
};

export default extension;
