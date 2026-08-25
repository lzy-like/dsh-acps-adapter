// dsh-acps — SdkBridgeClient: AIP client backed by the official acps-sdk.
//
// The acps-sdk is a Python package; a DSH plugin (Node/Cordis) cannot import
// it directly. This client spawns `bridge/acps_bridge.py` (which uses
// acps_sdk.aip.aip_rpc_client.AipRpcClient) in TCP mode and proxies AIP calls
// over a localhost line-delimited JSON-RPC socket. The child is spawned with
// stdio 'ignore' (no pipes) so the same code path works under any sandbox.
//
// The class implements the same surface as AipRpcClient (start/get/continue/
// complete/cancel returning TaskResult-shaped objects), so delegateTask in
// aip.js works unchanged.

import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Default bridge script location (package layout: lib/../bridge/acps_bridge.py). */
const DEFAULT_BRIDGE_SCRIPT = join(__dirname, "..", "bridge", "acps_bridge.py");

/** Pick a localhost port unlikely to collide with other bridge instances. */
function pickPort() {
	return 21_000 + (process.pid % 10_000) + Math.floor(Math.random() * 500);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class SdkBridgeClient {
	/**
	 * @param {object} opts
	 * @param {string} opts.url - Partner AIP JSON-RPC endpoint.
	 * @param {string} opts.leaderId - this Leader's AIC.
	 * @param {object} [opts.python] - { command, pythonPath, port, bridgeScript }.
	 * @param {number} [opts.timeoutMs] - per-request timeout.
	 * @param {object} [opts.logger]
	 */
	constructor({ url, leaderId, python = {}, timeoutMs = 30_000, logger }) {
		this.url = url;
		this.leaderId = leaderId;
		this.logger = logger;
		this.timeoutMs = timeoutMs;
		this.python = {
			command: python.command ?? "python",
			pythonPath: python.pythonPath ?? "",
			port: python.port ?? 0,
			bridgeScript: python.bridgeScript ?? DEFAULT_BRIDGE_SCRIPT,
		};
		this.port = this.python.port !== 0 ? this.python.port : pickPort();
		this.child = null;
		this.socket = null;
		this.buffer = "";
		this.pending = new Map();
		this.seq = 0;
		this.closed = false;
		this._connectPromise = null;
	}

	/** Spawn the bridge and connect; retries the TCP connect while the child warms up. */
	async connect() {
		if (this._connectPromise !== null) return this._connectPromise;
		this._connectPromise = this._doConnect();
		return this._connectPromise;
	}

	async _doConnect() {
		const env = { ...process.env };
		if (this.python.pythonPath !== "") {
			const existing = env.PYTHONPATH ?? "";
			env.PYTHONPATH = existing === "" ? this.python.pythonPath : `${this.python.pythonPath}${requirePathSep()}${existing}`;
		}
		this.child = spawn(this.python.command, [this.python.bridgeScript, "--port", String(this.port)], {
			env,
			stdio: ["ignore", "ignore", "ignore"],
			windowsHide: true,
		});
		this.child.on("exit", (code) => {
			if (!this.closed) {
				this.logger?.error?.("[acps] sdk bridge exited unexpectedly", { code, url: this.url });
			}
			this._failAll(new Error(`acps sdk bridge exited (code ${code})`));
		});
		// Wait for the TCP port to accept connections (python startup + imports).
		let lastError;
		for (let attempt = 0; attempt < 40; attempt += 1) {
			if (this.closed) throw new Error("acps sdk bridge closed during connect");
			try {
				await this._openSocket();
				this.logger?.info?.("[acps] sdk bridge connected", { url: this.url, port: this.port });
				return;
			} catch (error) {
				lastError = error;
				await sleep(250);
			}
		}
		throw new Error(`acps sdk bridge did not come up on 127.0.0.1:${this.port}: ${lastError?.message ?? "unknown"}`);
	}

	_openSocket() {
		return new Promise((resolve, reject) => {
			const socket = createConnection({ host: "127.0.0.1", port: this.port });
			const onError = (error) => {
				socket.destroy();
				reject(error);
			};
			socket.once("error", onError);
			socket.once("connect", () => {
				socket.removeListener("error", onError);
				this.socket = socket;
				socket.on("data", (chunk) => this._onData(chunk));
				socket.on("error", (error) => this._failAll(error));
				socket.on("close", () => this._failAll(new Error("acps sdk bridge connection closed")));
				resolve();
			});
		});
	}

	_onData(chunk) {
		this.buffer += chunk.toString("utf8");
		let index;
		while ((index = this.buffer.indexOf("\n")) !== -1) {
			const line = this.buffer.slice(0, index);
			this.buffer = this.buffer.slice(index + 1);
			if (line.trim() === "") continue;
			let message;
			try {
				message = JSON.parse(line);
			} catch {
				continue;
			}
			const handler = this.pending.get(message.id);
			if (handler !== void 0) {
				this.pending.delete(message.id);
				if (message.error !== void 0 && message.error !== null) {
					handler.reject(new Error(`acps sdk bridge error ${message.error.code}: ${message.error.message}`));
				} else {
					handler.resolve(message.result);
				}
			}
		}
	}

	_failAll(error) {
		for (const handler of this.pending.values()) handler.reject(error);
		this.pending.clear();
	}

	request(method, params, signal) {
		return new Promise((resolve, reject) => {
			const id = `req-${++this.seq}`;
			let timer = null;
			const onAbort = () => {
				if (timer !== null) clearTimeout(timer);
				this.pending.delete(id);
				reject(new DOMException("Aborted", "AbortError"));
			};
			if (signal !== void 0) {
				if (signal.aborted) return onAbort();
				signal.addEventListener("abort", onAbort, { once: true });
			}
			timer = setTimeout(() => {
				if (signal !== void 0) signal.removeEventListener("abort", onAbort);
				this.pending.delete(id);
				reject(new Error(`acps sdk bridge request ${method} timed out after ${this.timeoutMs}ms`));
			}, this.timeoutMs);
			this.pending.set(id, {
				resolve: (value) => {
					if (signal !== void 0) signal.removeEventListener("abort", onAbort);
					clearTimeout(timer);
					resolve(value);
				},
				reject: (error) => {
					if (signal !== void 0) signal.removeEventListener("abort", onAbort);
					clearTimeout(timer);
					reject(error);
				},
			});
			const payload = { jsonrpc: "2.0", id, method, params };
			this.socket?.write(`${JSON.stringify(payload)}\n`);
		});
	}

	async _call(method, params, signal) {
		await this.connect();
		return this.request(method, { url: this.url, leaderId: this.leaderId, ...params }, signal);
	}

	async start({ sessionId, taskId, text, commandParams, signal } = {}) {
		const result = await this._call("start", { sessionId, taskId, text, commandParams, timeoutMs: this.timeoutMs }, signal);
		return requireTaskResult(result, "start");
	}

	async get({ taskId, sessionId, signal } = {}) {
		const result = await this._call("get", { taskId, sessionId, timeoutMs: this.timeoutMs }, signal);
		return requireTaskResult(result, "get");
	}

	async continue({ taskId, sessionId, text, signal } = {}) {
		const result = await this._call("continue", { taskId, sessionId, text, timeoutMs: this.timeoutMs }, signal);
		return requireTaskResult(result, "continue");
	}

	async complete({ taskId, sessionId, signal } = {}) {
		const result = await this._call("complete", { taskId, sessionId, timeoutMs: this.timeoutMs }, signal);
		return requireTaskResult(result, "complete");
	}

	async cancel({ taskId, sessionId, signal } = {}) {
		const result = await this._call("cancel", { taskId, sessionId, timeoutMs: this.timeoutMs }, signal);
		return requireTaskResult(result, "cancel");
	}

	async close() {
		this.closed = true;
		this._failAll(new Error("acps sdk bridge closed"));
		if (this.socket !== null) {
			try { this.socket.destroy(); } catch { /* ignore */ }
			this.socket = null;
		}
		if (this.child !== null && this.child.exitCode === null) {
			try { this.child.kill(); } catch { /* ignore */ }
		}
		this.child = null;
	}
}

function requireTaskResult(result, op) {
	if (result === void 0 || result === null || typeof result !== "object" || result.type !== "task-result") {
		throw new Error(`acps sdk bridge: partner returned a non-TaskResult for ${op} (${JSON.stringify(result).slice(0, 200)})`);
	}
	return result;
}

function requirePathSep() {
	return process.platform === "win32" ? ";" : ":";
}
