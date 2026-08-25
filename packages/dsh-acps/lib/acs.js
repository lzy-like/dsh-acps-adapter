// dsh-acps — ACS (Agent Capability Specification) loading and normalization.
//
// An ACS is the machine-readable description of an ACPs agent (see
// acps-specs/03-ACPs-spec-ACS): identity (AIC), provider, endpoints
// (JSON-RPC `/rpc`, AMQP inbox), capabilities, and a `skills` array — each
// skill being a callable capability with id/name/description/tags/examples.
// The DSH leader maps each skill to one model-facing tool.

import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

/** Pick the JSON-RPC endpoint URL from an ACS endPoints array (HTTPS first). */
export function extractRpcEndpoint(acs) {
	const endpoints = Array.isArray(acs?.endPoints) ? acs.endPoints : [];
	const jsonRpc = endpoints.filter((ep) => {
		const transport = String(ep?.transport ?? "").toUpperCase();
		return transport === "JSONRPC" || transport === "RPC" || transport === "HTTP";
	});
	const https = jsonRpc.find((ep) => typeof ep?.url === "string" && ep.url.startsWith("https://"));
	if (https !== void 0) return https.url;
	const http = jsonRpc.find((ep) => typeof ep?.url === "string" && ep.url.startsWith("http://"));
	if (http !== void 0) return http.url;
	const anyUrl = endpoints.find((ep) => typeof ep?.url === "string" && /^https?:\/\//.test(ep.url));
	return anyUrl?.url;
}

/**
 * Load an ACS from one of three sources (first that applies):
 *  1. `acs` — inline object.
 *  2. `acsFile` — local JSON file path (absolute, or relative to `baseDir`).
 *  3. `acsUrl` — HTTP(S) JSON endpoint.
 * @param {object} opts
 * @param {object} [opts.acs]
 * @param {string} [opts.acsFile]
 * @param {string} [opts.acsUrl]
 * @param {Record<string,string>} [opts.headers]
 * @param {string} [opts.baseDir]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<object>} the parsed ACS object.
 */
export async function loadAcs({ acs, acsFile, acsUrl, headers = {}, baseDir = process.cwd(), signal } = {}) {
	if (acs !== void 0 && acs !== null && typeof acs === "object") return acs;
	if (acsFile !== void 0 && acsFile !== null && acsFile !== "") {
		const path = isAbsolute(acsFile) ? acsFile : resolve(baseDir, acsFile);
		const raw = await readFile(path, "utf8");
		return JSON.parse(raw);
	}
	if (acsUrl !== void 0 && acsUrl !== null && acsUrl !== "") {
		const response = await fetch(acsUrl, { headers, signal });
		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw new Error(`acs: HTTP ${response.status} fetching ${acsUrl}: ${text.slice(0, 300)}`);
		}
		return await response.json();
	}
	throw new Error("acs: no ACS source configured (set one of `acs`, `acsFile`, `acsUrl`)");
}

/** Normalize one ACS into the internal partner descriptor used by the bridge. */
export function normalizeAcs(acs, fallbackName = "partner") {
	if (acs === null || typeof acs !== "object") throw new Error("acs: invalid ACS (not an object)");
	const skills = Array.isArray(acs.skills) ? acs.skills : [];
	return {
		aic: typeof acs.aic === "string" ? acs.aic : "",
		name: typeof acs.name === "string" && acs.name !== "" ? acs.name : fallbackName,
		description: typeof acs.description === "string" ? acs.description : "",
		protocolVersion: typeof acs.protocolVersion === "string" ? acs.protocolVersion : "",
		endpoint: extractRpcEndpoint(acs),
		skills: skills.map((skill, index) => ({
			id: typeof skill?.id === "string" && skill.id !== "" ? skill.id : `skill-${index + 1}`,
			name: typeof skill?.name === "string" && skill.name !== "" ? skill.name : `skill-${index + 1}`,
			description: typeof skill?.description === "string" ? skill.description : "",
			version: typeof skill?.version === "string" ? skill.version : "",
			tags: Array.isArray(skill?.tags) ? skill.tags.map(String) : [],
			examples: Array.isArray(skill?.examples) ? skill.examples.map(String) : [],
			inputModes: Array.isArray(skill?.inputModes) ? skill.inputModes.map(String) : [],
			outputModes: Array.isArray(skill?.outputModes) ? skill.outputModes.map(String) : [],
		})),
	};
}

/** Compose the model-facing tool description for one skill. */
export function skillToolDescription(partnerName, skill) {
	const lines = [];
	lines.push(`调用 ACPs Partner 智能体「${partnerName}」的技能「${skill.name}」(id: ${skill.id})。`);
	if (skill.description !== "") lines.push(skill.description);
	if (skill.tags.length > 0) lines.push(`标签: ${skill.tags.join("、")}`);
	if (skill.examples.length > 0) {
		lines.push(`示例请求:`);
		for (const example of skill.examples.slice(0, 3)) lines.push(`- ${example}`);
	}
	lines.push(`请求内容应为自然语言描述的具体任务；该智能体自行判断能力范围并返回结果。`);
	return lines.join("\n");
}
