import { createRoot, type Root } from "react-dom/client";
import { App } from "./App.tsx";
import type { AppProps } from "./App.tsx";

export { App } from "./App.tsx";
export type { AppProps, Viewport } from "./App.tsx";
export { Layout } from "./Layout.tsx";
export { Sidebar } from "./Sidebar.tsx";
export { Wrapper } from "./Wrapper.tsx";
export { renderFrame } from "./Frame.tsx";
export type { FrameProps } from "./Frame.tsx";

let root: Root | null = null;

/** Renders the dev UI shell: sidebar, toolbar and the story frame(s). */
export function render(container: HTMLElement, options: AppProps) {
  if (!root) {
    root = createRoot(container);
  }
  root.render(<App {...options} />);
}
