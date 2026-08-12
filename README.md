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

## CLI

```
storybun                       Start the dev server
storybun snapshot [options]    Capture every story and compare against its baseline
storybun list [options]        Print every story key
storybun shot <story> [opts]   Write a PNG of one story, leaving baselines untouched
```

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

### Visual Snapshots

`bunx storybun snapshot` renders every story in headless Chromium and compares it
against the baseline in `outDir`, writing `<story>.actual.png` and
`<story>.diff.png` for anything that moved. `--update` accepts the current render
as the new baseline.

```ts
export default {
  snapshot: {
    // Where baselines live (default: "__snapshots__")
    outDir: "__snapshots__",

    // Percentage of differing pixels tolerated (default: 0.1)
    threshold: 0.1,

    // Viewports to capture each story at (default: one 1280x720 shot)
    viewports: [{ width: 1280, height: 720 }],

    // Extra settle time in ms after the story signals ready (default: 0)
    waitTimeout: 0,

    // Pages captured in parallel (default: 4)
    concurrency: 4,

    // Freeze `Date.now()` and `new Date()` at this instant. Without it, any
    // story that renders a relative timestamp ("6 minutes ago") or a ticking
    // duration diffs against its own baseline on every run.
    clock: "2026-07-30T12:00:00.000Z",

    // Page timezone and locale, fixed so local runs match CI
    timezoneId: "UTC",
    locale: "en-US",
  },
} satisfies StorybunConfig;
```

Timers keep running under `clock` — only the reported time is frozen — so a
component polling on an interval simply re-renders the same output. Story
fixtures should therefore express timestamps at or before the frozen instant, so
that relative labels read as the past.

### Single Snapshots

`storybun snapshot` is a regression check: it owns `outDir` and rewrites what it
finds there. When you just want a picture of one component -- to eyeball a change,
attach to a review, or hand to a tool that cannot drive a browser -- use `shot`,
which writes exactly where you point it and never reads or replaces a baseline.

```bash
storybun list                                   # every story key
storybun list --filter Button --json            # machine-readable, narrowed

storybun shot 'Components/Button--Primary' -o button.png
storybun shot Primary --viewport 800x600        # unique substrings resolve too
storybun shot 'Components/Table--Wide' --full-page
```

The key is `<story path>--<export>`, exactly as `list` prints it. A query that
matches nothing, or matches more than one story, exits non-zero and lists the
candidates rather than guessing.

The page is set up exactly as it is for baselines -- same wrappers, plugins,
frozen `clock`, `timezoneId` and `locale` -- so a `shot` shows what the baseline
run sees. Playwright is still required; `shot` only saves you from driving it.

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
