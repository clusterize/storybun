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

### Visual Snapshots

`bunx storybun snapshot` renders every story in headless Chromium and compares it
against the baseline in `outDir`, writing `<story>.actual.png` and
`<story>.diff.png` for anything that moved. `--update` accepts the current render
as the new baseline.

Each snapshot captures the story's own content, cropped to its own box — not
the viewport and not the wrapper. The wrapper still renders around it (theme
context, providers, stylesheets), it just isn't part of the captured pixels.

```ts
export default {
  snapshot: {
    // Where baselines live (default: "__snapshots__")
    outDir: "__snapshots__",

    // Percentage of differing pixels tolerated (default: 0.1)
    threshold: 0.1,

    // Viewport sizes to render each story at before capture (default: one
    // 1280x720 viewport). The captured image is cropped to the story's own
    // content, not this size — a narrow or short story still produces a
    // narrow or short PNG regardless of viewport.
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

    // Environments every story is captured in, on top of `viewports`. Each
    // story is captured once per mode and the mode name is appended to the
    // baseline filename (`Button--Primary-dark.png`). Unset captures each
    // story once, unsuffixed.
    modes: {
      light: { colorScheme: "light" },
      dark: { colorScheme: "dark" },
    },
  },
} satisfies StorybunConfig;
```

A mode changes what the browser reports to the page -- `prefers-color-scheme`,
and optionally a `locale` or `timezoneId` override -- never what a story renders
on its own. It is meant for a theme that follows the OS preference: with the two
modes above every story gets a light and a dark baseline without a story per
theme. A theme read from storage instead of the media query does not react to a
mode, and needs a Wrapper that maps the mode onto it.

Turning modes on renames every baseline once (`X.png` becomes `X-light.png` and
`X-dark.png`); the unsuffixed files are left in place and can be deleted.

Timers keep running under `clock` — only the reported time is frozen — so a
component polling on an interval simply re-renders the same output. Story
fixtures should therefore express timestamps at or before the frozen instant, so
that relative labels read as the past.

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
