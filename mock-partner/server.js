// dsh-acps mock ACPs Partner servers.
//
// Implements the AIP direct-mode RPC protocol (ACPs-spec-AIP v02.01) well
// enough for local end-to-end verification of the DSH leader bridge:
//
//   POST /rpc     JSON-RPC 2.0 { method: "rpc", params: { command: TaskCommand } }
//                 → { result: TaskResult }
//   GET  /health  { agent, status, tasks }
//   GET  /acs     the partner's ACS (Agent Capability Specification) JSON
//
// Task lifecycle: start → accepted → working → awaiting-completion (product
// ready); get polls the current state; complete moves to completed; cancel
// moves to canceled. A partner may enter awaiting-input when the request is
// too vague (configured per partner), demonstrating the clarification flow.
//
// One partner per directory under ./partners, each with acs.json and an
// optional mock.json ({ productTemplate, awaitInputPattern, timingsMs }).
// Ports are assigned by discovery order starting at 9021 (override with
// --port-offset).

import { createServer } from "node:http";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PARTNERS_DIR = join(__dirname, "partners");
const PORT_OFFSET = Number(process.argv[2] ?? "9021");

const TASK_STATE = {
	ACCEPTED: "accepted",
	WORKING: "working",
	AWAITING_INPUT: "awaiting-input",
	AWAITING_COMPLETION: "awaiting-completion",
	COMPLETED: "completed",
	CANCELED: "canceled",
	FAILED: "failed",
	REJECTED: "rejected",
};

const TERMINAL = new Set([TASK_STATE.COMPLETED, TASK_STATE.CANCELED, TASK_STATE.FAILED, TASK_STATE.REJECTED]);

function nowIso() {
	return new Date().toISOString();
}

function makeTaskResult(agent, command, state, { dataItems = [], products = [] } = {}) {
	const taskId = command.taskId ?? command.id;
	return {
		type: "task-result",
		id: `result-${taskId}`,
		sentAt: nowIso(),
		senderRole: "partner",
		senderId: agent.name,
		taskId,
		sessionId: command.sessionId,
		status: {
			state,
			stateChangedAt: nowIso(),
			dataItems,
		},
		...(products.length > 0 ? { products } : {}),
		commandHistory: [command],
		statusHistory: [],
	};
}

function textItem(text) {
	return { type: "text", text };
}

/** One mock partner agent. */
class MockPartner {
	constructor(name, dir, port) {
		this.name = name;
		this.dir = dir;
		this.port = port;
		this.acs = JSON.parse(readFileSync(join(dir, "acs.json"), "utf8"));
		const mockPath = join(dir, "mock.json");
		this.mock = existsSync(mockPath) ? JSON.parse(readFileSync(mockPath, "utf8")) : {};
		this.tasks = new Map();
	}

	endpoint() {
		return `http://127.0.0.1:${this.port}/rpc`;
	}

	/** Run the simulated pipeline after accept. */
	schedule(task, command) {
		const timings = { ...{ workingMs: 400, productMs: 1400 }, ...(this.mock.timingsMs ?? {}) };
		const request = extractText(command);
		const awaitInputPattern = this.mock.awaitInputPattern;
		task.timers = [];
		if (awaitInputPattern && new RegExp(awaitInputPattern, "i").test(request)) {
			const question = this.mock.inputQuestion ?? "请提供更多细节（例如具体地点、口味偏好或时间安排），我才能给出合适的推荐。";
			task.timers.push(setTimeout(() => {
				task.result = makeTaskResult(this, command, TASK_STATE.AWAITING_INPUT, {
					dataItems: [textItem(question)],
				});
			}, timings.workingMs));
			return;
		}
		task.timers.push(setTimeout(() => {
			task.result = makeTaskResult(this, command, TASK_STATE.WORKING, {
				dataItems: [textItem(`正在为您处理：${truncate(request, 60)}`)],
			});
			task.timers.push(setTimeout(() => {
				const productText = renderTemplate(this.mock.productTemplate ?? "【{{name}}】模拟产出（请求：{{request}}）", {
					name: this.acs.name ?? this.name,
					request,
				});
				task.result = makeTaskResult(this, command, TASK_STATE.AWAITING_COMPLETION, {
					products: [{
						id: `prod-${taskIdSuffix(command)}`,
						name: `${this.acs.name ?? this.name} 推荐结果`,
						description: "该智能体基于请求生成的推荐结果（演示模拟数据）",
						dataItems: [textItem(productText)],
					}],
				});
			}, timings.productMs));
		}, timings.workingMs));
	}

	/** Dispatch one RPC request. Returns { result } or { error }. */
	async dispatch(request) {
		const body = request.body;
		if (body?.method !== "rpc" || body?.params?.command === void 0) {
			return { error: { code: -32600, message: "Invalid Request: expected method=rpc with params.command" } };
		}
		const command = body.params.command;
		const taskId = command.taskId ?? command.id;
		const existing = this.tasks.get(taskId);
		const state = existing?.result?.status?.state;

		switch (command.command) {
			case "start": {
				if (existing !== void 0) return { result: existing.result }; // idempotent
				const accepted = makeTaskResult(this, command, TASK_STATE.ACCEPTED);
				const task = { result: accepted, timers: [] };
				this.tasks.set(taskId, task);
				this.schedule(task, command);
				return { result: accepted };
			}
			case "get": {
				if (existing === void 0) return { error: { code: -32001, message: "Task not found" } };
				return { result: existing.result };
			}
			case "continue": {
				if (existing === void 0) return { error: { code: -32001, message: "Task not found" } };
				if (state !== TASK_STATE.AWAITING_INPUT && state !== TASK_STATE.AWAITING_COMPLETION) {
					return { result: existing.result }; // ignored per spec
				}
				existing.timers.forEach(clearTimeout);
				existing.timers = [];
				existing.result = makeTaskResult(this, command, TASK_STATE.WORKING, {
					dataItems: [textItem(`收到补充信息：${truncate(extractText(command), 60)}`)],
				});
				this.schedule(existing, command);
				return { result: existing.result };
			}
			case "complete": {
				if (existing === void 0) return { error: { code: -32001, message: "Task not found" } };
				if (state !== TASK_STATE.AWAITING_COMPLETION) return { result: existing.result };
				existing.timers.forEach(clearTimeout);
				existing.timers = [];
				// keep the products delivered with awaiting-completion (per AIP the
				// product list belongs to the task, not to one status snapshot)
				const previous = existing.result;
				existing.result = {
					...makeTaskResult(this, command, TASK_STATE.COMPLETED),
					products: previous?.products ?? [],
				};
				return { result: existing.result };
			}
			case "cancel": {
				if (existing === void 0) return { error: { code: -32001, message: "Task not found" } };
				if (TERMINAL.has(state)) return { result: existing.result };
				existing.timers.forEach(clearTimeout);
				existing.timers = [];
				existing.result = makeTaskResult(this, command, TASK_STATE.CANCELED);
				return { result: existing.result };
			}
			default:
				return { error: { code: -32601, message: `Method not found: command=${command.command}` } };
		}
	}

	server() {
		return createServer(async (req, res) => {
			const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
			res.setHeader("Access-Control-Allow-Origin", "*");
			res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
			res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
			if (req.method === "OPTIONS") {
				res.writeHead(204);
				res.end();
				return;
			}
			if (req.method === "GET" && url.pathname === "/health") {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ agent: this.name, status: "online", tasks: { active: this.tasks.size }, endpoint: this.endpoint() }));
				return;
			}
			if (req.method === "GET" && url.pathname === "/acs") {
				res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
				res.end(JSON.stringify(this.acs));
				return;
			}
			if (req.method === "POST" && url.pathname === "/rpc") {
				let raw = "";
				for await (const chunk of req) raw += chunk;
				let parsed;
				try {
					parsed = JSON.parse(raw);
				} catch {
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
					return;
				}
				const outcome = await this.dispatch({ body: parsed });
				const response = {
					jsonrpc: "2.0",
					id: parsed.id ?? null,
					...(outcome.error !== void 0 ? { error: outcome.error } : { result: outcome.result }),
				};
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(response));
				return;
			}
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: `not found: ${url.pathname}` }));
		});
	}
}

function extractText(command) {
	const items = Array.isArray(command?.dataItems) ? command.dataItems : [];
	return items.filter((item) => item?.type === "text" && typeof item.text === "string")
		.map((item) => item.text).join("\n");
}

function truncate(text, max) {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

function taskIdSuffix(command) {
	return String(command.taskId ?? "x").slice(-8);
}

function renderTemplate(template, values) {
	return template.replace(/\{\{(\w+)\}\}/g, (_, key) => String(values[key] ?? ""));
}

function discoverPartners() {
	const dirs = readdirSync(PARTNERS_DIR, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
	return dirs.map((name, index) => {
		const partner = new MockPartner(name, join(PARTNERS_DIR, name), PORT_OFFSET + index);
		// Serve on the port the ACS itself advertises (endPoints[0].url), so
		// the advertised endpoint always points at the right agent regardless
		// of directory ordering. Falls back to PORT_OFFSET + index.
		const advertised = extractEndpointPort(partner.acs);
		if (advertised !== void 0) partner.port = advertised;
		return partner;
	});
}

/** Extract the port from the ACS JSON-RPC endpoint URL, when present. */
function extractEndpointPort(acs) {
	const endpoints = Array.isArray(acs?.endPoints) ? acs.endPoints : [];
	for (const ep of endpoints) {
		if (typeof ep?.url !== "string") continue;
		try {
			const parsed = new URL(ep.url);
			if (parsed.port !== "") return Number(parsed.port);
		} catch { /* not a URL */ }
	}
	return void 0;
}

const partners = discoverPartners();
if (partners.length === 0) {
	console.error(`[mock-partner] no partner directories under ${PARTNERS_DIR}`);
	process.exit(1);
}
for (const partner of partners) {
	partner.server().listen(partner.port, "127.0.0.1", () => {
		console.log(`[mock-partner] ${partner.name} listening on ${partner.endpoint()} (${partner.acs.name ?? ""})`);
	});
}
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
console.log(`[mock-partner] started ${partners.length} partner(s), first port ${PORT_OFFSET}`);
