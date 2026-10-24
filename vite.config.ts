import vinext from "vinext";
import { defineConfig } from "vite";

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // The self-hosted service runs in Node. Workers builds need a separate
  // target because the Cloudflare adapter now emits runtime-only imports.
  const workers = process.env.MONITOR_BUILD_TARGET === "cloudflare";
  const { cloudflare } = workers ? await import("@cloudflare/vite-plugin") : { cloudflare: null };

  return {
    plugins: [
      vinext(),
      ...(cloudflare ? [cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: {
          main: "./worker/index.ts",
          compatibility_flags: ["nodejs_compat"],
        },
      })] : []),
    ],
  };
});
