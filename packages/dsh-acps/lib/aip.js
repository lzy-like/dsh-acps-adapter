// dsh-acps — AIP (Agent Interaction Protocol) client.
//
// Implements the direct-mode RPC style of the ACPs Agent Interaction Protocol
// (ACPs-spec-AIP v02.01): the Leader sends TaskCommand objects to a Partner's
// JSON-RPC `/rpc` endpoint and receives TaskResult objects back. Transport is
// plain HTTP(S) with an optional bearer token; mTLS is left to the deployment
// (the request goes through Node's fetch, so system trust stores apply).
//
// Wire shapes (see acps-sdk/acps_sdk/aip/*):
//   RpcRequest   = { jsonrpc: "2.0", method: "rpc", id, params: { command: TaskCommand } }
//   RpcResponse  = { jsonrpc: "2.0", id, result?: TaskResult, error?: { code, message, data? } }
//   TaskCommand  = { type: "task-command", id, sentAt, senderRole: "leader", senderId,
//                    dataItems?, sessionId?, command, commandParams?, taskId? }
//   TaskResult   = { type: "task-result", id, sentAt, senderRole: "partner", senderId,
//                    taskId, sessionId?, status: { state, stateChangedAt, dataItems? },
//                    products?, commandHistory?, statusHistory? }
//   DataItem     = { type: "text", text } | { type: "file", ... } | { type: "data", data }

import { randomUUID } from "node:crypto";

/** AIP task states (TaskState enum). */
export const TASK_STATE = Object.freeze({
	ACCEPTED: "accepted",
	WORKING: "working",
	AWAITING_INPUT: "awaiting-input",
	AWAITING_COMPLETION: "awaiting-completion",
	COMPLETED: "completed",
	CANCELED: "canceled",
	FAILED: "failed",
	REJECTED: "rejected",
});

/** Terminal states: no further progress is possible. */
export const TERMINAL_STATES = new Set([
	TASK_STATE.COMPLETED,
	TASK_STATE.CANCELED,
	TASK_STATE.FAILED,
	TASK_STATE.REJECTED,
]);

/** AIP task command types (TaskCommandType enum). */
export const COMMAND_TYPE = Object.freeze({
	GET: "get",
	START: "start",
	CONTINUE: "continue",
	CANCEL: "cancel",
	COMPLETE: "complete",
	RE_STREAM: "re-stream",
});

/** AIP-specific JSON-RPC error codes (server error range -32000..-32099). */
export const AIP_ERROR = Object.freeze({
	TASK_NOT_FOUND: -32001,
	TASK_NOT_CANCELABLE: -32002,
	NOTIFICATION_NOT_SUPPORTED: -32003,
	UNSUPPORTED_OPERATION: -32004,
	CONTENT_TYPE_NOT_SUPPORTED: -32005,
	INVALID_AGENT_RESPONSE: -32006,
	GROUP_NOT_SUPPORTED: -32007,
	AUTHENTICATION_REQUIRED: -32008,
	AUTHORIZATION_FAILED: -32009,
	ACCESS_TOKEN_INVALID: -32010,
});

/** Error thrown for a JSON-RPC error response or an HTTP failure. */
export class AipRpcError extends Error {
	constructor(message, { code = void 0, data = void 0, cause = void 0 } = {}) {
		super(message, cause === void 0 ? void 0 : { cause });
		this.name = "AipRpcError";
		this.code = code;
		this.data = data;
	}
}

/** A stable AIP client for one Partner endpoint. */
export class AipRpcClient {
	/**
	 * @param {object} opts
	 * @param {string} opts.url - Partner JSON-RPC endpoint (e.g. http://host:port/rpc).
	 * @param {string} opts.leaderId - this Leader's AIC, sent as `senderId`.
	 * @param {Record<string,string>} [opts.headers] - extra headers (e.g. Authorization).
	 * @param {number} [opts.timeoutMs] - per-request timeout.
	 */
	constructor({ url, leaderId, headers = {}, timeoutMs = 30_000 }) {
		if (!url || typeof url !== "string") throw new Error(`aip: invalid partner url ${JSON.stringify(url)}`);
		if (!leaderId || typeof leaderId !== "string") throw new Error("aip: leaderId (AIC) is required");
		this.url = url;
		this.leaderId = leaderId;
		this.headers = headers;
		this.timeoutMs = timeoutMs;
	}

	/** Build a TaskCommand for `command` with optional text payload. */
	buildCommand(command, { taskId, sessionId, text, commandParams } = {}) {
		const dataItems = text === void 0 || text === null || text === ""
			? void 0
			: [{ type: "text", text: String(text) }];
		return {
			type: "task-command",
			id: `cmd-${randomUUID()}`,
			sentAt: new Date().toISOString(),
			senderRole: "leader",
			senderId: this.leaderId,
			...(dataItems !== void 0 ? { dataItems } : {}),
			...(sessionId !== void 0 ? { sessionId } : {}),
			command,
			...(commandParams !== void 0 ? { commandParams } : {}),
			...(taskId !== void 0 ? { taskId } : {}),
		};
	}

	/**
	 * Send one RPC request and return the parsed response.
	 * @param {object} command - the TaskCommand payload.
	 * @param {AbortSignal} [signal] - caller cancellation.
	 * @returns {Promise<object>} the JSON-RPC response object (result or error already distinguished).
	 */
	async send(command, signal) {
		const requestId = `req-${randomUUID()}`;
		const body = {
			jsonrpc: "2.0",
			method: "rpc",
			id: requestId,
			params: { command },
		};
		let response;
		try {
			response = await fetch(this.url, {
				method: "POST",
				headers: { "Content-Type": "application/json", ...this.headers },
				body: JSON.stringify(body),
				signal,
			});
		} catch (error) {
			throw new AipRpcError(`aip: request to ${this.url} failed: ${error.message}`, { cause: error });
		}
		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw new AipRpcError(`aip: HTTP ${response.status} from ${this.url}: ${text.slice(0, 500)}`);
		}
		let payload;
		try {
			payload = await response.json();
		} catch (error) {
			throw new AipRpcError(`aip: invalid JSON response from ${this.url}: ${error.message}`, { cause: error });
		}
		if (payload.error !== void 0 && payload.error !== null) {
			const { code, message, data } = payload.error;
			throw new AipRpcError(`aip: partner error ${code} - ${message}${data !== void 0 ? ` (${JSON.stringify(data).slice(0, 300)})` : ""}`, { code, data });
		}
		if (payload.id !== requestId) {
			throw new AipRpcError(`aip: response id mismatch from ${this.url} (expected ${requestId}, got ${String(payload.id)})`);
		}
		return payload.result;
	}

	/** Send a `start` command and return the TaskResult. */
	async start({ sessionId, taskId, text, commandParams, signal }) {
		const command = this.buildCommand(COMMAND_TYPE.START, { taskId, sessionId, text, commandParams });
		const result = await this.send(command, signal);
		return requireTaskResult(result, "start");
	}

	/** Send a `get` command and return the TaskResult. */
	async get({ taskId, sessionId, signal }) {
		const command = this.buildCommand(COMMAND_TYPE.GET, { taskId, sessionId });
		const result = await this.send(command, signal);
		return requireTaskResult(result, "get");
	}

	/** Send a `continue` command (provide more input) and return the TaskResult. */
	async continue({ taskId, sessionId, text, signal }) {
		const command = this.buildCommand(COMMAND_TYPE.CONTINUE, { taskId, sessionId, text });
		const result = await this.send(command, signal);
		return requireTaskResult(result, "continue");
	}

	/** Send a `complete` command (accept the product) and return the TaskResult. */
	async complete({ taskId, sessionId, signal }) {
		const command = this.buildCommand(COMMAND_TYPE.COMPLETE, { taskId, sessionId });
		const result = await this.send(command, signal);
		return requireTaskResult(result, "complete");
	}

	/** Send a `cancel` command and return the TaskResult. */
	async cancel({ taskId, sessionId, signal }) {
		const command = this.buildCommand(COMMAND_TYPE.CANCEL, { taskId, sessionId });
		const result = await this.send(command, signal);
		return requireTaskResult(result, "cancel");
	}
}

function requireTaskResult(result, op) {
	if (result === void 0 || result === null || typeof result !== "object" || result.type !== "task-result") {
		throw new AipRpcError(`aip: partner returned a non-TaskResult for ${op} (got ${JSON.stringify(result).slice(0, 200)})`);
	}
	return result;
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
	if (signal !== void 0 && signal.aborted) return reject(new DOMException("Aborted", "AbortError"));
	const timer = setTimeout(() => {
		signal === void 0 || signal.removeEventListener("abort", onAbort);
		resolve();
	}, ms);
	const onAbort = () => {
		clearTimeout(timer);
		reject(new DOMException("Aborted", "AbortError"));
	};
	if (signal !== void 0) signal.addEventListener("abort", onAbort, { once: true });
});

/**
 * One full delegation round: start a task with `request`, poll until the
 * partner converges, complete on AwaitingCompletion, and return the outcome.
 *
 * Convergence policy (mirrors the ACPs reference leader):
 *  - awaiting-input  → stop; the partner needs more information (returned as `needsInput`).
 *  - awaiting-completion → send `complete` (unless disabled), then return products.
 *  - terminal states → return as-is.
 *
 * @param {AipRpcClient} client
 * @param {object} opts
 * @param {string} opts.request - natural-language task request sent to the partner.
 * @param {string} [opts.sessionId] - leader-side session id (defaults to a fresh uuid).
 * @param {string} [opts.taskId] - leader-side task id (defaults to a fresh uuid).
 * @param {number} [opts.pollIntervalMs=2000]
 * @param {number} [opts.pollTimeoutMs=300000] - overall deadline for the delegation.
 * @param {boolean} [opts.completeOnAwaitingCompletion=true]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<object>} { state, needsInput, inputQuestion, products, dataItems, taskResult, taskId, sessionId }
 */
export async function delegateTask(client, {
	request,
	sessionId = `session-${randomUUID()}`,
	taskId = `task-${randomUUID()}`,
	pollIntervalMs = 2_000,
	pollTimeoutMs = 300_000,
	completeOnAwaitingCompletion = true,
	signal,
} = {}) {
	if (typeof request !== "string" || request.trim() === "") {
		throw new Error("aip: delegation request must be a non-empty string");
	}
	const deadline = Date.now() + pollTimeoutMs;
	let lastResult;
	try {
		lastResult = await client.start({ sessionId, taskId, text: request, signal });
	} catch (error) {
		if (isAbort(error)) throw error;
		return { state: TASK_STATE.FAILED, error: `start failed: ${error.message}`, taskId, sessionId };
	}

	for (;;) {
		const state = lastResult?.status?.state;
		if (state === TASK_STATE.AWAITING_INPUT) {
			const question = extractDataItemsText(lastResult.status?.dataItems) || extractDataItemsText(lastResult.products);
			return {
				state,
				needsInput: true,
				inputQuestion: question,
				products: extractProducts(lastResult),
				dataItems: extractDataItems(lastResult),
				taskResult: lastResult,
				taskId,
				sessionId,
			};
		}
		if (state === TASK_STATE.AWAITING_COMPLETION) {
			if (completeOnAwaitingCompletion) {
				try {
					lastResult = await client.complete({ taskId, sessionId, signal });
				} catch (error) {
					if (isAbort(error)) throw error;
					// completion is best-effort; keep the awaiting-completion products
					return {
						state,
						needsInput: false,
						products: extractProducts(lastResult),
						dataItems: extractDataItems(lastResult),
						taskResult: lastResult,
						taskId,
						sessionId,
						note: `complete command failed: ${error.message}`,
					};
				}
				continue; // re-read the state after complete
			}
			return {
				state,
				needsInput: false,
				products: extractProducts(lastResult),
				dataItems: extractDataItems(lastResult),
				taskResult: lastResult,
				taskId,
				sessionId,
			};
		}
		if (TERMINAL_STATES.has(state)) {
			return {
				state,
				needsInput: false,
				products: extractProducts(lastResult),
				dataItems: extractDataItems(lastResult),
				taskResult: lastResult,
				taskId,
				sessionId,
			};
		}
		if (Date.now() > deadline) {
			// best-effort cancel so the partner does not keep working forever
			try {
				await client.cancel({ taskId, sessionId, signal });
			} catch { /* ignore */ }
			return {
				state: TASK_STATE.CANCELED,
				error: `delegation timed out after ${pollTimeoutMs}ms`,
				taskId,
				sessionId,
				taskResult: lastResult,
			};
		}
		try {
			lastResult = await client.get({ taskId, sessionId, signal });
		} catch (error) {
			if (isAbort(error)) throw error;
			// transient get failures: keep polling until the deadline
			lastResult = lastResult;
		}
		await sleep(pollIntervalMs, signal);
	}
}

function isAbort(error) {
	return error !== void 0 && error !== null && (error.name === "AbortError" || error.name === "TimeoutError");
}

/** Extract the text of one data-item list, joined by newlines. */
export function extractDataItemsText(dataItems) {
	if (!Array.isArray(dataItems)) return "";
	const parts = [];
	for (const item of dataItems) {
		if (item === null || typeof item !== "object") continue;
		if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
		else if (item.type === "data" && item.data !== void 0) parts.push(JSON.stringify(item.data));
		else if (item.type === "file") {
			const bits = [];
			if (item.name !== void 0) bits.push(item.name);
			if (item.uri !== void 0) bits.push(item.uri);
			if (bits.length > 0) parts.push(`file: ${bits.join(" ")}`);
		}
	}
	return parts.join("\n");
}

/** Collect all data items from a task result's status and products. */
export function extractDataItems(taskResult) {
	const items = [];
	if (taskResult?.status?.dataItems) items.push(...taskResult.status.dataItems);
	for (const product of taskResult?.products ?? []) {
		if (Array.isArray(product?.dataItems)) items.push(...product.dataItems);
	}
	return items;
}

/** Project products into a stable JSON-friendly shape: [{ id, name, description, text }]. */
export function extractProducts(taskResult) {
	if (!Array.isArray(taskResult?.products)) return [];
	return taskResult.products.map((product) => ({
		id: product?.id ?? "",
		...(product?.name !== void 0 ? { name: product.name } : {}),
		...(product?.description !== void 0 ? { description: product.description } : {}),
		text: extractDataItemsText(product?.dataItems),
	}));
}
