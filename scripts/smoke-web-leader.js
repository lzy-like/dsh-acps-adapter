// Hermetic smoke test for the web-leader bridge (WebLeaderClient):
// spins up a local mock of an ACPs leader chat API and verifies the client's
// request/response handling. No external network needed.
//
// Usage: node scripts/smoke-web-leader.js

import { createServer } from "node:http";
import { WebLeaderClient } from "../packages/dsh-acps/lib/web-leader.js";

let failures = 0;
const check = (name, cond, detail = "") => {
	if (cond) console.log(`  ✓ ${name}`);
	else { failures += 1; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};

// Mock leader chat API: echoes the outfit-style payload shape.
const server = createServer(async (req, res) => {
	let raw = "";
	for await (const chunk of req) raw += chunk;
	const body = JSON.parse(raw || "{}");
	if (!body.session_id) {
		res.writeHead(422, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ detail: [{ loc: ["body", "session_id"], msg: "Field required" }] }));
		return;
	}
	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify({
		session_id: body.session_id,
		reply: "👕 上衣：半袖棉（浅蓝）\n👖 裤子：短裤棉（米白）",
		task_id: "web-mock-1",
		aip_state: "awaiting-completion",
		partner_result_state: "awaiting-completion",
		discovery_source: "adp",
		partner: { aic: "mock.outfit.001", name: "穿搭推荐智能体", endpoint: "https://mock/rpc", skills: ["个性化穿搭推荐"] },
		product: { reply_text: "👕 上衣：半袖棉（浅蓝）", intent: "OUTFIT_RECOMMEND", is_complete: true },
	}));
});

const PORT = 18_900 + Math.floor(Math.random() * 400);

await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));

try {
	console.log("1) chat success");
	const client = new WebLeaderClient({ url: `http://127.0.0.1:${PORT}/api/chat`, headers: { Connection: "close" } });
	const outcome = await client.chat({ message: "上海，INFP，心情平静，推荐穿搭", sessionId: "sess-1" });
	check("reply parsed", outcome.reply.includes("上衣"), outcome.reply);
	check("session id echoed", outcome.sessionId === "sess-1", outcome.sessionId);
	check("partner parsed", outcome.partner?.name === "穿搭推荐智能体", JSON.stringify(outcome.partner));
	check("state parsed", outcome.state === "awaiting-completion", outcome.state);

	console.log("2) missing session_id → HTTP 422 → WebLeaderError");
	try {
		await client.chat({ message: "hi", sessionId: "" });
		check("422 raises", false);
	} catch (error) {
		check("422 raises", error.name === "WebLeaderError" && error.status === 422, error.message);
	}

	console.log("3) empty message rejected");
	try {
		await client.chat({ message: "   " });
		check("empty message rejected", false);
	} catch (error) {
		check("empty message rejected", error.name === "WebLeaderError", error.message);
	}
} finally {
	server.closeAllConnections?.();
	await new Promise((resolve) => server.close(resolve));
}

console.log(failures === 0 ? "\nWEB-LEADER SMOKE PASSED" : `\n${failures} CHECK(S) FAILED`);
// Let libuv settle lingering keep-alive handles before exiting (Windows).
setTimeout(() => process.exit(failures === 0 ? 0 : 1), 150);
