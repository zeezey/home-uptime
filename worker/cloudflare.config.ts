import { bindings, defineConfig, triggers } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
	worker: {
		name: "home-uptime",
		compatibilityDate: "2026-09-30",
		entrypoint,
		env: {
			// One key, `state` (see src/logic.ts). Namespace "home-uptime-state".
			STATE: bindings.kv({ id: "79a73c9095ed43d98ec3d51b3a793b51" }),
			// The ntfy URL (same as the launcher's LAUNCHER_ALERT_WEBHOOK). Set on Cloudflare, never in this repo.
			ALERT_WEBHOOK: bindings.secret(),
			// Two OPTIONAL secrets, set on Cloudflare (dashboard: Workers > home-uptime > Settings > Variables and
			// Secrets), not declared here: NTFY_TOKEN (an ntfy.sh account token -- anonymous ntfy.sh refuses Workers)
			// and DISCORD_WEBHOOK (fallback channel). See send() in src/index.ts and the README.
		},
		triggers: [triggers.scheduled({ schedule: "*/5 * * * *" })],
		// Workers Logs: each run's up/DOWN lines and alert results (`cf observability telemetry query`, 3 days).
		observability: { enabled: true },
	},
});
