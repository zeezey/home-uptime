// home-uptime, the Cloudflare half: checks the launcher, the other public products (targets.txt) and every live
// listing every 5 minutes from Cloudflare's network (outside the house), and alerts the phone when something goes
// down, hourly while it stays down, and once when it comes back. The GitHub workflow beside it does the same job but
// GitHub runs its */10 schedule only every 3-5 hours, so this is the one that keeps time.
//
// The run itself is in run.ts (with its I/O passed in, so the tests can drive it); this file wires it to the
// Workers runtime: the cron trigger, the real fetch, and the /status page.
import targetsTxt from "../../targets.txt?raw";
import { readState, run, statusBody, type Deps, type Env } from "./run.ts";

const deps: Deps = {
	fetch: (url, init) => fetch(url, init),
	sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
	log: (line) => console.log(line),
};

export default {
	async scheduled(_controller, env: Env) {
		await run(env, targetsTxt, deps);
	},

	async fetch(req: Request, env: Env) {
		const { pathname } = new URL(req.url);
		if (pathname === "/status") {
			return Response.json(statusBody(await readState(env.STATE)), { headers: { "cache-control": "no-store" } });
		}
		return new Response("home-uptime: see /status\n", { status: pathname === "/" ? 200 : 404 });
	},
} satisfies ExportedHandler<Env>;
