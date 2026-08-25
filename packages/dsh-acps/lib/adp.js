// dsh-acps — ADP (Agent Discovery Protocol) client.
//
// Queries an ACPs discovery server (acps-spec-ADP) for agents whose
// capabilities match a natural-language query. The leader uses it to learn
// about partners it was not statically configured with.
//
//   POST {serverBaseUrl}/discover
//   { "type": "explicit", "query": "...", "limit": N, "filter": {...}? }
//   → { "result": { "acsMap": { aic: ACS }, "agents": [ { group, agentSkills: [ { aic, skillId, ranking } ] } ] } }

/** Error raised when the discovery server reports a failure. */
export class AdpError extends Error {
	constructor(message, { code = void 0, data = void 0, cause = void 0 } = {}) {
		super(message, cause === void 0 ? void 0 : { cause });
		this.name = "AdpError";
		this.code = code;
		this.data = data;
	}
}

/**
 * Run one discovery query.
 * @param {object} opts
 * @param {string} opts.serverBaseUrl - ADP server base URL (without /discover).
 * @param {string} opts.query - natural-language capability query.
 * @param {number} [opts.limit=10]
 * @param {object} [opts.filter] - optional structured DiscoveryFilter.
 * @param {Record<string,string>} [opts.headers]
 * @param {number} [opts.timeoutMs=30000]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ acsMap: Record<string,object>, agents: Array<{ group: string, agentSkills: Array<{ aic: string, skillId: string, ranking: number }> }> }>}
 */
export async function discover({ serverBaseUrl, query, limit = 10, filter, headers = {}, timeoutMs = 30_000, signal } = {}) {
	if (!serverBaseUrl) throw new AdpError("adp: serverBaseUrl is required");
	if (typeof query !== "string" || query.trim() === "") throw new AdpError("adp: query must be a non-empty string");
	const url = `${serverBaseUrl.replace(/\/+$/, "")}/discover`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const onOuterAbort = () => controller.abort();
	if (signal !== void 0) {
		if (signal.aborted) controller.abort();
		else signal.addEventListener("abort", onOuterAbort, { once: true });
	}
	const payload = {
		type: "explicit",
		query,
		limit,
		...(filter !== void 0 && filter !== null ? { filter } : {}),
	};
	try {
		const response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...headers },
			body: JSON.stringify(payload),
			signal: controller.signal,
		});
		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw new AdpError(`adp: HTTP ${response.status} from ${url}: ${text.slice(0, 300)}`);
		}
		const body = await response.json();
		if (body.error !== void 0 && body.error !== null) {
			throw new AdpError(`adp: server error ${body.error.code ?? "?"} - ${body.error.message ?? "unknown"}`, { code: body.error.code, data: body.error.data });
		}
		const result = body.result ?? {};
		return {
			acsMap: result.acsMap ?? {},
			agents: Array.isArray(result.agents) ? result.agents.map((group) => ({
				group: group?.group ?? "",
				agentSkills: Array.isArray(group?.agentSkills) ? group.agentSkills.map((skill) => ({
					aic: skill?.aic ?? "",
					skillId: skill?.skillId ?? "",
					ranking: skill?.ranking ?? 0,
					...(skill?.memo !== void 0 ? { memo: skill.memo } : {}),
				})) : [],
			})) : [],
		};
	} catch (error) {
		if (error instanceof AdpError) throw error;
		if (error?.name === "AbortError") throw new AdpError(`adp: discovery request to ${url} timed out after ${timeoutMs}ms`, { cause: error });
		throw new AdpError(`adp: discovery request to ${url} failed: ${error.message}`, { cause: error });
	} finally {
		clearTimeout(timer);
		if (signal !== void 0) signal.removeEventListener("abort", onOuterAbort);
	}
}

/** Derive a stable short partner id from an AIC (last segment, lowercased, sanitized). */
export function partnerIdFromAic(aic) {
	const raw = String(aic ?? "");
	const segments = raw.split(".");
	const last = segments[segments.length - 1] ?? "";
	const sanitized = last.replace(/[^A-Za-z0-9_-]/g, "_").toLowerCase();
	return sanitized === "" ? `agent-${Math.abs(hashCode(raw)).toString(36)}` : sanitized;
}

function hashCode(value) {
	let hash = 0;
	for (let i = 0; i < value.length; i += 1) {
		hash = (hash * 31 + value.charCodeAt(i)) | 0;
	}
	return hash;
}
