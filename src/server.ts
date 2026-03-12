import type { Server } from "bun";
import type { BuildResult } from "./builder.ts";

interface ServerState {
  html: string;
  assets: Map<string, string>;
}

const state: ServerState = {
  html: "",
  assets: new Map(),
};

export function startServer(buildResult: BuildResult, port: number): Server {
  state.html = buildResult.html;
  state.assets = buildResult.assets;

  const server = Bun.serve({
    port,
    fetch(req, server) {
      const url = new URL(req.url);

      // WebSocket upgrade
      if (url.pathname === "/__storybun_ws") {
        if (server.upgrade(req)) return;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      // Serve index
      if (url.pathname === "/") {
        return new Response(state.html, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      // Serve assets
      const assetPath = state.assets.get(url.pathname);
      if (assetPath) {
        return new Response(Bun.file(assetPath));
      }

      // 404
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        ws.subscribe("reload");
      },
      message() {},
      close(ws) {
        ws.unsubscribe("reload");
      },
    },
  });

  return server;
}

export function updateServer(
  server: Server<unknown>,
  buildResult: BuildResult,
) {
  state.html = buildResult.html;
  state.assets = buildResult.assets;
  server.publish("reload", "reload");
}
