# storybun

A fast, zero-config component explorer built on [Bun](https://bun.sh). Think Storybook, but instant.

## Features

- **Instant startup** — Bun-native bundling, no Webpack/Vite overhead
- **Zero config** — Scans `**/*.stories.tsx` files out of the box
- **Hot reload** — WebSocket-based live reload on file changes
- **Monorepo support** — Discovers packages automatically, per-package config and wrappers
- **Customizable UI** — Replace Layout, Sidebar, or Wrapper components
- **Style isolation** — Storybun's styles never leak into your components
- **Dark/light theme** — Follows system preference

## Quick Start

```bash
bun install storybun
```

Create a story file:

```tsx
// src/Button.stories.tsx
import { Button } from "./Button";

export const Primary = () => <Button>Click me</Button>;
export const Secondary = () => <Button variant="secondary">Click me</Button>;
```

Run the dev server:

```bash
bunx storybun
```

Open [http://localhost:5175](http://localhost:5175).

## Story Format

Each `.stories.tsx` file exports named components. Every named export becomes a story:

```tsx
// Card.stories.tsx
import { Card } from "./Card";

export const Default = () => <Card>Hello</Card>;
export const WithImage = () => <Card image="/hero.png">Hello</Card>;
```

The sidebar tree is derived from file paths — `src/components/Card.stories.tsx` becomes `Components/Card`.

## Configuration

Create `storybun.config.ts` in your project root:

```ts
import type { StorybunConfig } from "storybun";

export default {
  // Glob patterns for story files (default: ["**/*.stories.tsx"])
  stories: ["src/**/*.stories.tsx"],

  // Dev server port (default: 5175)
  port: 3000,

  // Bun plugins applied during build
  plugins: [],

  // Override UI components
  components: {
    Layout: "./src/storybun/Layout.tsx",
    Sidebar: "./src/storybun/Sidebar.tsx",
    Wrapper: "./src/storybun/Wrapper.tsx",
  },
} satisfies StorybunConfig;
```

### Monorepo / Per-Package Config

In a monorepo, storybun discovers each story's nearest `package.json` and groups stories by package. Each package can have its own `storybun.config.ts` with per-package plugins and a custom `Wrapper`:

```ts
// packages/design-system/storybun.config.ts
export default {
  plugins: [/* package-specific Bun plugins */],
  components: {
    Wrapper: "./src/ThemeWrapper.tsx",
  },
};
```

## Custom Components

### Wrapper

Wraps each story. Useful for providing theme context or global styles:

```tsx
export function Wrapper({ children }: { children: React.ReactNode }) {
  return <ThemeProvider>{children}</ThemeProvider>;
}
```

### Layout

Controls the overall page structure (sidebar + content area).

### Sidebar

Controls the story navigation tree.

## License

MIT
