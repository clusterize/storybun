import type { Server } from "bun";
import type { SnapshotBuildResult } from "./entry.ts";

export function startSnapshotServer(buildResult: SnapshotBuildResult): Server {
  const server = Bun.serve({
    port: 0, // OS-assigned random port
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/snapshot") {
        return new Response(buildResult.html, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      const assetPath = buildResult.assets.get(url.pathname);
      if (assetPath) {
        return new Response(Bun.file(assetPath));
      }

      return new Response("Not found", { status: 404 });
    },
  });

  return server;
}
