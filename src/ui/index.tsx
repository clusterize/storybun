import { createRoot, type Root } from "react-dom/client";
import { App } from "./App.tsx";
import type { AppProps } from "./App.tsx";

export { App } from "./App.tsx";
export { Layout } from "./Layout.tsx";
export { Sidebar } from "./Sidebar.tsx";
export { Wrapper } from "./Wrapper.tsx";

let root: Root | null = null;

export function render(container: HTMLElement, options: AppProps) {
  if (!root) {
    root = createRoot(container);
  }
  root.render(
    <App
      stories={options.stories}
      modules={options.modules}
      components={options.components}
      wrappers={options.wrappers}
    />,
  );
}
