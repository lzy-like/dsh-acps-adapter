// dsh-acps — WebLeaderClient: bridge to an ACPs Leader's public web API.
//
// Some ACPs partner `/rpc` endpoints are gated behind mTLS with certificates
// issued by the ACPs development CA (the ecosystem's trust model: agents hold
// identity certificates from the ACPs CA, see ACPs-spec-ATR/AIA). The leader
// applications in that ecosystem already hold such certificates, so they
// expose a public chat API that performs the AIP delegation internally.
//
// This client lets the DSH leader delegate to such a leader through its
// public endpoint (e.g. POST {url} with { session_id, message }), keeping
// multi-turn session continuity by reusing the DSH agent's session id.
//
// Response shape (clothes.renew.cc.cd, an official ACPs outfit leader):
//   { session_id, reply, task_id, aip_state, partner_result_state,
//     discovery_source, partner: {aic,name,endpoint,skills}, product: {...} }

/** Error raised for a web-leader bridge failure. */
export class WebLeaderError extends Error {
	constructor(message, { status = void 0, cause = void 0 } = {}) {
		super(message, cause === void 0 ? void 0 : { cause });
		this.name = "WebLeaderError";
		this.status = status;
	}
}

export class WebLeaderClient {
	/**
	 * @param {object} opts
	 * @param {string} opts.url - public chat endpoint (e.g. https://host/api/chat).
	 * @param {Record<string,string>} [opts.headers] - extra headers.
	 * @param {number} [opts.timeoutMs]
	 * @param {object} [opts.logger]
	 */
	constructor({ url, headers = {}, timeoutMs = 60_000, logger }) {
		if (!url || typeof url !== "string") throw new Error(`web-leader: invalid url ${JSON.stringify(url)}`);
		this.url = url;
		this.headers = headers;
		this.timeoutMs = timeoutMs;
		this.logger = logger;
	}

	/**
	 * Send one natural-language message to the leader and return its reply.
	 * @param {object} opts
	 * @param {string} opts.message
	 * @param {string} [opts.sessionId]
	 * @param {AbortSignal} [opts.signal]
	 * @returns {Promise<{sessionId: string, reply: string, state: string, partner: object|null, product: object|null, note: string}>}
	 */
	async chat({ message, sessionId, signal }) {
		if (typeof message !== "string" || message.trim() === "") {
			throw new WebLeaderError("web-leader: message must be a non-empty string");
		}
		const body = { session_id: sessionId ?? "", message };
		let response;
		try {
			response = await fetch(this.url, {
				method: "POST",
				headers: { "Content-Type": "application/json", ...this.headers },
				body: JSON.stringify(body),
				signal,
			});
		} catch (error) {
			throw new WebLeaderError(`web-leader: request to ${this.url} failed: ${error.message}`, { cause: error });
		}
		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw new WebLeaderError(`web-leader: HTTP ${response.status} from ${this.url}: ${text.slice(0, 400)}`, { status: response.status });
		}
		let payload;
		try {
			payload = await response.json();
		} catch (error) {
			throw new WebLeaderError(`web-leader: invalid JSON from ${this.url}: ${error.message}`, { cause: error });
		}
		if (payload?.error !== void 0 && payload.error !== null) {
			throw new WebLeaderError(`web-leader: leader error: ${JSON.stringify(payload.error).slice(0, 400)}`);
		}
		return {
			sessionId: typeof payload?.session_id === "string" ? payload.session_id : (sessionId ?? ""),
			reply: typeof payload?.reply === "string" ? payload.reply : "",
			state: typeof payload?.aip_state === "string" ? payload.aip_state : "unknown",
			partner: payload?.partner ?? null,
			product: payload?.product ?? null,
			...(typeof payload?.task_id === "string" ? { taskId: payload.task_id } : {}),
		};
	}
}
