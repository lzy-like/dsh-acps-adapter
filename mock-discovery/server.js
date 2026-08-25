// Mock ADP (Agent Discovery Protocol) discovery server for local verification.
//
// Implements POST {base}/discover, returning every partner under
// ../mock-partner/partners as discovery candidates with their full ACS in
// acsMap — enough for the dsh-acps plugin to auto-register discovered
// partners and for the acps_discover tool to answer runtime queries.
//
// Response shape (acps-spec-ADP):
//   { "result": { "acsMap": { aic: ACS }, "agents": [ { "group", "agentSkills": [ { "aic", "skillId", "ranking" } ] } ] } }
//
// Usage: node server.js [port=9050] [partnersDir=../mock-partner/partners]

import { createServer } from "node:http";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] ?? 9050);
const PARTNERS_DIR = resolve(process.argv[3] ?? join(__dirname, "..", "mock-partner", "partners"));

function loadPartners() {
	const dirs = readdirSync(PARTNERS_DIR, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
	const partners = [];
	for (const name of dirs) {
		const acsPath = join(PARTNERS_DIR, name, "acs.json");
		if (!existsSync(acsPath)) continue;
		const acs = JSON.parse(readFileSync(acsPath, "utf8"));
		partners.push({ name, acs });
	}
	return partners;
}

const partners = loadPartners();
if (partners.length === 0) {
	console.error(`[mock-adp] no partner ACS files under ${PARTNERS_DIR}`);
	process.exit(1);
}

const acsMap = Object.fromEntries(partners.map(({ acs }) => [acs.aic, acs]));
const agentSkills = partners.flatMap(({ acs }) =>
	(Array.isArray(acs.skills) ? acs.skills : []).map((skill, index) => ({
		aic: acs.aic,
		skillId: skill.id,
		ranking: index + 1,
	})),
);

const server = createServer(async (req, res) => {
	const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
	res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
	if (req.method === "OPTIONS") {
		res.writeHead(204);
		res.end();
		return;
	}
	if (req.method === "GET" && url.pathname === "/health") {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ status: "online", partners: partners.length }));
		return;
	}
	if (req.method === "POST" && url.pathname === "/discover") {
		let raw = "";
		for await (const chunk of req) raw += chunk;
		let body = {};
		try {
			body = JSON.parse(raw);
		} catch { /* defaults */ }
		const query = typeof body.query === "string" ? body.query : "";
		// Very light matching: everything is returned; the client filters.
		const result = {
			acsMap,
			agents: [
				{
					group: query || "全部",
					agentSkills,
				},
			],
		};
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ result }));
		return;
	}
	res.writeHead(404, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ error: `not found: ${url.pathname}` }));
});

server.listen(PORT, "127.0.0.1", () => {
	console.log(`[mock-adp] discovery server on http://127.0.0.1:${PORT} serving ${partners.length} partner(s) from ${PARTNERS_DIR}`);
});
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
