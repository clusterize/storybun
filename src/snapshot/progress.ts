import type { CaptureResult } from "./capture.ts";

/** One capture finished, successfully or not; emitted by `captureAll`. */
export interface CaptureProgress {
  /** 1-based count of finished captures, in completion order. */
  index: number;
  total: number;
  storyKey: string;
  mode?: string;
  viewport: { width: number; height: number; name?: string };
  durationMs: number;
  error?: Error;
  /** What `onCapture` said about this capture, e.g. "changed 3.2%"; printed after the time. */
  outcome?: string;
}

export interface CaptureHooks {
  /** Called once with the number of captures the run will attempt. */
  onStart?: (total: number) => void;
  /**
   * Called inside the worker with each finished capture, pixels included,
   * before the next story on that worker starts. This is where the capture
   * is compared or written: the buffer is dropped once the hook returns.
   * A returned string is shown on the progress line.
   */
  onCapture?: (capture: CaptureResult) => Promise<string | void> | string | void;
  onProgress?: (event: CaptureProgress) => void;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

export function captureLabel(
  storyKey: string,
  mode: string | undefined,
  viewport: { width: number; height: number; name?: string },
  singleViewport: boolean,
): string {
  let label = storyKey;
  if (mode) label += ` [${mode}]`;
  if (!singleViewport) label += ` @${viewport.name ?? `${viewport.width}x${viewport.height}`}`;
  return label;
}

/**
 * `[  12/618] Components/Button--Primary [dark] 0.8s`, followed by the
 * capture's outcome when there is one to report (`+ new`, `changed 3.2%`),
 * or with `✗` and the first line of the error for a failed capture. The
 * index is padded to the width of the total so the lines line up.
 */
export function formatProgress(event: CaptureProgress, singleViewport: boolean): string {
  const width = String(event.total).length;
  const counter = `[${String(event.index).padStart(width)}/${event.total}]`;
  const label = captureLabel(event.storyKey, event.mode, event.viewport, singleViewport);
  const time = formatDuration(event.durationMs);
  if (event.error) {
    const reason = event.error.message.split("\n")[0];
    return `${counter} ✗ ${label} ${time}: ${reason}`;
  }
  return event.outcome ? `${counter} ${label} ${time} ${event.outcome}` : `${counter} ${label} ${time}`;
}

export function formatPlan(
  stories: number,
  exports: number,
  viewports: number,
  modes: number,
  total: number,
  concurrency: number,
): string {
  const axes = [`${exports} ${exports === 1 ? "story" : "stories"} in ${stories} ${stories === 1 ? "file" : "files"}`];
  if (viewports > 1) axes.push(`${viewports} viewports`);
  if (modes > 0) axes.push(`${modes} ${modes === 1 ? "mode" : "modes"}`);
  return `Capturing ${total} ${total === 1 ? "snapshot" : "snapshots"} (${axes.join(" × ")}) with concurrency ${concurrency}`;
}
