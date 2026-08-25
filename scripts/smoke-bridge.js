// Standalone test of the Python acps-sdk bridge over TCP: spawns
// acps_bridge.py --port N (stdio ignore, no pipes), connects via localhost
// socket, and drives one full AIP delegation cycle with the official SDK.
// Usage: node scripts/smoke-bridge.js [partnerUrl]

import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRIDGE = join(__dirname, "..", "packages", "dsh-acps", "bridge", "acps_bridge.py");
const PYLIB = join(__dirname, "..", ".pylibs");
const partnerUrl = process.argv[2] ?? "http://127.0.0.1:9021/rpc";
const PORT = 21_500 + Math.floor(Math.random() * 400);

let failures = 0;
const check = (name, cond, detail = "") => {
	if (cond) console.log(`  ✓ ${name}`);
	else { failures += 1; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect() {
	return new Promise((resolve, reject) => {
		const socket = createConnection({ host: "127.0.0.1", port: PORT });
		socket.once("error", reject);
		socket.once("connect", () => {
			socket.removeListener("error", reject);
			resolve(socket);
		});
	});
}

async function main() {
	const child = spawn("python", [BRIDGE, "--port", String(PORT)], {
		env: { ...process.env, PYTHONPATH: PYLIB },
		stdio: ["ignore", "ignore", "ignore"],
		windowsHide: true,
	});
	let socket;
	try {
		// Wait for the bridge to bind its port.
		let lastError;
		for (let attempt = 0; attempt < 40; attempt += 1) {
			try { socket = await connect(); break; }
			catch (error) { lastError = error; await sleep(250); }
		}
		if (!socket) throw new Error(`bridge did not come up on port ${PORT}: ${lastError?.message ?? "unknown"}`);

		let buffer = "";
		const pending = new Map();
		let seq = 0;
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			let index;
			while ((index = buffer.indexOf("\n")) !== -1) {
				const line = buffer.slice(0, index);
				buffer = buffer.slice(index + 1);
				if (!line.trim()) continue;
				let msg;
				try { msg = JSON.parse(line); } catch { continue; }
				const handler = pending.get(msg.id);
				if (handler) { pending.delete(msg.id); handler(msg); }
			}
		});

		const call = (method, params, timeoutMs = 30_000) => new Promise((resolve, reject) => {
			const id = `req-${++seq}`;
			const timer = setTimeout(() => { pending.delete(id); reject(new Error(`bridge request ${method} timed out`)); }, timeoutMs);
			pending.set(id, (msg) => {
				clearTimeout(timer);
				if (msg.error) reject(new Error(`bridge error ${msg.error.code}: ${msg.error.message}`));
				else resolve(msg.result);
			});
			socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		});

		console.log("1) bridge ping");
		const pong = await call("ping");
		check("ping ok (acps-sdk)", pong?.pong === true && typeof pong.sdk === "string", JSON.stringify(pong));

		console.log("2) start via acps-sdk");
		const started = await call("start", { url: partnerUrl, leaderId: "dsh-leader-001", sessionId: "bridge-test-1", taskId: "bridge-task-1", text: "我想吃正宗的北京烤鸭，请推荐老字号餐厅" });
		check("start returns TaskResult", started?.type === "task-result" && started?.status?.state === "accepted", started?.status?.state);

		console.log("3) poll get until awaiting-completion, then complete");
		let state = started?.status?.state;
		for (let i = 0; i < 20; i += 1) {
			await sleep(400);
			const got = await call("get", { url: partnerUrl, leaderId: "dsh-leader-001", taskId: "bridge-task-1", sessionId: "bridge-test-1" });
			state = got?.status?.state;
			if (state === "awaiting-completion" || ["completed", "canceled", "failed", "rejected"].includes(state)) break;
		}
		check("reached awaiting-completion", state === "awaiting-completion", state);
		const completed = await call("complete", { url: partnerUrl, leaderId: "dsh-leader-001", taskId: "bridge-task-1", sessionId: "bridge-test-1" });
		check("complete → completed", completed?.status?.state === "completed", completed?.status?.state);
		check("products survive completion", Array.isArray(completed?.products) && completed.products.length >= 1);
		const text = completed?.products?.[0]?.dataItems?.map((d) => d.text ?? "").join("\n") ?? "";
		check("product text round-trips (camelCase)", text.includes("烤鸭") || text.includes("全聚德"), text.slice(0, 60));

		console.log("4) error handling");
		try {
			await call("get", { url: partnerUrl, leaderId: "dsh-leader-001", taskId: "does-not-exist", sessionId: "x" });
			check("unknown task raises", false);
		} catch (error) {
			check("unknown task raises", /-32001|Task not found/i.test(error.message), error.message);
		}
	} finally {
		try { socket?.destroy(); } catch { /* ignore */ }
		try { child.kill(); } catch { /* ignore */ }
	}

	console.log(failures === 0 ? "\nBRIDGE SMOKE PASSED" : `\n${failures} CHECK(S) FAILED`);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
	console.error("bridge smoke crashed:", error);
	process.exit(1);
});
