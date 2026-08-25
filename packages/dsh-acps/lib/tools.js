// dsh-acps — tool bridge: map ACPs partner skills to DSH ToolRuntime tools.
//
// Each partner skill becomes a model-facing tool named
// `acps__<partnerId>__<skillId>` (normalized to the DeepSeek function-name
// contract: <=64 chars, [A-Za-z0-9_-], deterministic hash suffix on lossy
// normalization — same discipline as the MCP bridge). Executing the tool
// delegates a natural-language request to the partner over AIP RPC and waits
// for the partner's product.

import { createHash } from "node:crypto";
import { AipRpcClient, delegateTask, extractDataItemsText } from "./aip.js";
import { SdkBridgeClient } from "./sdk-bridge.js";
import { WebLeaderClient } from "./web-leader.js";
import { discover } from "./adp.js";

/** DeepSeek function-name contract: at most 64 characters. */
const MAX_PUBLIC_NAME_LENGTH = 64;
/** DeepSeek function-name contract: only [A-Za-z0-9_-]. */
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g;
/** Hex chars of the SHA-256 identity hash appended on lossy normalization. */
const HASH_LENGTH = 12;

/**
 * Derive the model-facing public name for one partner skill.
 * Deterministic pure function of (partnerId, skillId).
 */
export function publicToolName(partnerId, rawSkillId) {
	const joined = `acps__${partnerId}__${rawSkillId}`;
	const normalized = joined.replace(INVALID_NAME_CHARS, "_");
	if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized;
	const hash = createHash("sha256").update(`${partnerId}\0${rawSkillId}`).digest("hex").slice(0, HASH_LENGTH);
	return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`;
}

/** The delegation result schema shared by every partner tool. */
function delegationOutputSchema() {
	return {
		schema: {
			type: "object",
			properties: {
				state: { type: "string", description: "AIP task state (accepted/working/awaiting-input/awaiting-completion/completed/canceled/failed/rejected)." },
				partner: { type: "string", description: "Partner display name." },
				skill: { type: "string", description: "Skill id that was invoked." },
				needsInput: { type: "boolean", description: "Whether the partner is waiting for more information." },
				inputQuestion: { type: "string", description: "Question the partner asked when waiting for input." },
				products: {
					type: "array",
					items: {
						type: "object",
						properties: {
							id: { type: "string" },
							name: { type: "string" },
							description: { type: "string" },
							text: { type: "string" },
						},
					},
					description: "The partner's produced output items.",
				},
				dataItemsText: { type: "string", description: "All status/product data items as plain text." },
				note: { type: "string", description: "Additional note (e.g. completion command failure)." },
				error: { type: "string", description: "Failure message when the delegation could not complete." },
				taskId: { type: "string" },
				sessionId: { type: "string" },
			},
			required: ["state", "partner", "skill"],
			additionalProperties: false,
		},
		render(_args, value) {
			const lines = [];
			if (value.state === "awaiting-input") {
				lines.push(`[ACPs Partner「${value.partner}」需要更多信息]`);
				if (value.inputQuestion) lines.push(value.inputQuestion);
				lines.push("请补充所需信息后再次调用本工具。");
			} else if (value.error) {
				lines.push(`[ACPs Partner「${value.partner}」执行失败: ${value.error}]`);
			} else {
				lines.push(`[ACPs Partner「${value.partner}」技能「${value.skill}」结果 (state: ${value.state})]`);
				const products = Array.isArray(value.products) ? value.products : [];
				if (products.length === 0) {
					lines.push(value.dataItemsText || "(partner 未返回产出物)");
				} else {
					for (const product of products) {
						const title = product.name ? product.name : (product.id ? product.id : "产出");
						if (product.description) lines.push(`【${title}】${product.description}`);
						if (product.text) lines.push(product.text);
					}
				}
				if (value.note) lines.push(`(备注: ${value.note})`);
			}
			return [{ type: "text", text: lines.filter(Boolean).join("\n") }];
		},
	};
}

/** Build the execute closure for one partner skill tool. */
function createSkillExecutor({ client, partnerId, partnerName, skillId, logger, opts }) {
	return async (args, exec) => {
		const request = args.request;
		try {
			const outcome = await delegateTask(client, {
				request,
				pollIntervalMs: opts.pollIntervalMs,
				pollTimeoutMs: opts.pollTimeoutMs,
				completeOnAwaitingCompletion: opts.completeOnAwaitingCompletion,
				signal: exec.signal,
			});
			logger?.info?.("[acps] delegation settled", { partner: partnerId, skill: skillId, state: outcome.state, taskId: outcome.taskId });
			return {
				state: outcome.state,
				partner: partnerName,
				skill: skillId,
				needsInput: outcome.needsInput === true,
				...(outcome.inputQuestion !== void 0 ? { inputQuestion: outcome.inputQuestion } : {}),
				products: outcome.products ?? [],
				dataItemsText: extractDataItemsText(outcome.dataItems ?? []),
				...(outcome.note !== void 0 ? { note: outcome.note } : {}),
				...(outcome.error !== void 0 ? { error: outcome.error } : {}),
				taskId: outcome.taskId,
				sessionId: outcome.sessionId,
			};
		} catch (error) {
			logger?.warn?.("[acps] delegation failed", { partner: partnerId, skill: skillId, error: String(error) });
			throw new Error(`ACPs partner「${partnerName}」技能「${skillId}」调用失败: ${error.message}`);
		}
	};
}

/** Build a ToolDefinition for one partner skill. */
export function createSkillTool({ partnerId, partnerName, partnerAic, skill, client, opts, logger }) {
	const publicName = publicToolName(partnerId, skill.id);
	const descriptionParts = [];
	descriptionParts.push(`委托 ACPs Partner 智能体「${partnerName}」执行任务。`);
	if (partnerAic) descriptionParts.push(`Partner AIC: ${partnerAic}`);
	descriptionParts.push(`技能: ${skill.name} (${skill.id})`);
	if (skill.description) descriptionParts.push(skill.description);
	if (skill.tags.length > 0) descriptionParts.push(`标签: ${skill.tags.join("、")}`);
	if (skill.examples.length > 0) {
		descriptionParts.push("示例请求:");
		for (const example of skill.examples.slice(0, 3)) descriptionParts.push(`- ${example}`);
	}
	descriptionParts.push("参数 request 为自然语言任务描述；该智能体会自行判断并返回结果。需要补充信息时工具会返回其提问。");
	return {
		name: publicName,
		description: descriptionParts.join("\n"),
		parameters: {
			type: "object",
			properties: {
				request: {
					type: "string",
					description: `要委托给「${partnerName}」的自然语言任务请求。`,
				},
			},
			required: ["request"],
			additionalProperties: false,
		},
		output: delegationOutputSchema(),
		execute: createSkillExecutor({ client, partnerId, partnerName, skillId: skill.id, logger, opts }),
		// Delegations are long-running external calls; never overlap them.
		isConcurrencySafe: () => false,
		timeoutMs: opts.pollTimeoutMs + 15_000,
	};
}

/** Build a whole-agent delegate tool (used when the ACS declares no skills). */
export function createDelegateTool({ partnerId, partnerName, partnerAic, client, opts, logger }) {
	const publicName = publicToolName(partnerId, "delegate");
	return {
		name: publicName,
		description: `把整个任务委托给 ACPs Partner 智能体「${partnerName}」${partnerAic ? `(AIC: ${partnerAic})` : ""}，由其自行判断能力范围并执行。参数 request 为自然语言任务描述。`,
		parameters: {
			type: "object",
			properties: {
				request: { type: "string", description: "要委托给该智能体的自然语言任务请求。" },
			},
			required: ["request"],
			additionalProperties: false,
		},
		output: delegationOutputSchema(),
		execute: createSkillExecutor({ client, partnerId, partnerName, skillId: "delegate", logger, opts }),
		isConcurrencySafe: () => false,
		timeoutMs: opts.pollTimeoutMs + 15_000,
	};
}

/** Build the discovery tool (registered when an ADP server is configured). */
export function createDiscoverTool({ discovery, logger }) {
	return {
		name: "acps_discover",
		description: `通过 ACPs ADP 发现服务 (${discovery.serverBaseUrl}) 查询当前可用的 ACPs 智能体及其技能。返回匹配的智能体列表（名称、AIC、技能与端点）。用于在需要选择合作智能体时了解生态。`,
		parameters: {
			type: "object",
			properties: {
				query: { type: "string", description: "自然语言能力查询，如“北京美食推荐”。" },
			},
			required: ["query"],
			additionalProperties: false,
		},
		output: {
			schema: {
				type: "object",
				properties: {
					query: { type: "string" },
					candidates: {
						type: "array",
						items: {
							type: "object",
							properties: {
								aic: { type: "string" },
								name: { type: "string" },
								description: { type: "string" },
								endpoint: { type: "string" },
								skills: {
									type: "array",
									items: {
										type: "object",
										properties: {
											id: { type: "string" },
											name: { type: "string" },
											description: { type: "string" },
											tags: { type: "array", items: { type: "string" } },
										},
									},
								},
							},
						},
					},
					error: { type: "string" },
				},
				required: ["query"],
				additionalProperties: false,
			},
			render(_args, value) {
				const lines = [`[ACPs 发现结果 (query: ${value.query})]`];
				if (value.error) {
					lines.push(`发现服务查询失败: ${value.error}`);
				} else if (!Array.isArray(value.candidates) || value.candidates.length === 0) {
					lines.push("没有找到匹配的智能体。");
				} else {
					for (const candidate of value.candidates) {
						lines.push(`- ${candidate.name} (AIC: ${candidate.aic}, 端点: ${candidate.endpoint ?? "未知"})`);
						if (candidate.description) lines.push(`  描述: ${candidate.description}`);
						for (const skill of candidate.skills ?? []) {
							lines.push(`  * 技能 ${skill.name} [${skill.id}]: ${skill.description}`);
						}
					}
				}
				return [{ type: "text", text: lines.join("\n") }];
			},
		},
		async execute(args, exec) {
			try {
				const result = await discover({
					serverBaseUrl: discovery.serverBaseUrl,
					query: args.query,
					limit: discovery.limit ?? 10,
					headers: discovery.headers ?? {},
					signal: exec.signal,
				});
				logger?.info?.("[acps] discovery settled", { query: args.query });
				const candidates = [];
				const seen = new Set();
				for (const group of result.agents) {
					for (const skill of group.agentSkills) {
						const key = `${skill.aic}:${skill.skillId}`;
						if (seen.has(key)) continue;
						seen.add(key);
						const acs = result.acsMap[skill.aic] ?? {};
						candidates.push({
							aic: skill.aic,
							name: acs.name ?? skill.aic,
							description: acs.description ?? "",
							endpoint: extractEndpoint(acs),
							skills: [{
								id: skill.skillId,
								name: skillName(acs, skill.skillId),
								description: skillDescription(acs, skill.skillId),
								tags: skillTags(acs, skill.skillId),
							}],
						});
					}
				}
				return { query: args.query, candidates };
			} catch (error) {
				logger?.warn?.("[acps] discovery failed", { error: String(error) });
				return { query: args.query, error: error.message };
			}
		},
	};
}

function extractEndpoint(acs) {
	const endpoints = Array.isArray(acs?.endPoints) ? acs.endPoints : [];
	const url = endpoints.find((ep) => typeof ep?.url === "string")?.url;
	return url ?? "";
}

function findSkill(acs, skillId) {
	return (Array.isArray(acs?.skills) ? acs.skills : []).find((skill) => skill?.id === skillId);
}

function skillName(acs, skillId) {
	return findSkill(acs, skillId)?.name ?? skillId;
}

function skillDescription(acs, skillId) {
	return findSkill(acs, skillId)?.description ?? "";
}

function skillTags(acs, skillId) {
	return Array.isArray(findSkill(acs, skillId)?.tags) ? findSkill(acs, skillId).tags.map(String) : [];
}

/**
 * Build the web-leader bridge tool: delegates a request through an ACPs
 * Leader's public chat API (that leader holds the ecosystem certificates and
 * performs the AIP calls to its partners internally).
 */
export function createWebLeaderTool({ leaderCfg, logger }) {
	const publicName = publicToolName(leaderCfg.id, "web-coordination");
	const client = new WebLeaderClient({
		url: leaderCfg.url,
		headers: leaderCfg.headers ?? {},
		timeoutMs: leaderCfg.requestTimeoutMs ?? 60_000,
		logger,
	});
	const descriptionParts = [];
	descriptionParts.push(`通过 ACPs Leader「${leaderCfg.name}」的公开协作接口委托任务。`);
	descriptionParts.push("该 Leader 内部会通过 ACPs 发现（ADP）找到合适的 Partner 智能体，并用 AIP 协议完成调用（例如穿搭推荐 Leader 会调用「穿搭推荐智能体」生成个性化穿搭方案）。");
	if (leaderCfg.description) descriptionParts.push(leaderCfg.description);
	descriptionParts.push("参数 request 为自然语言任务描述；返回该 Leader 的最终回复。");
	return {
		name: publicName,
		description: descriptionParts.join("\n"),
		parameters: {
			type: "object",
			properties: {
				request: { type: "string", description: `要委托给「${leaderCfg.name}」的自然语言任务。` },
			},
			required: ["request"],
			additionalProperties: false,
		},
		output: {
			schema: {
				type: "object",
				properties: {
					state: { type: "string", description: "Leader 侧 AIP 任务状态。" },
					leader: { type: "string", description: "Leader 名称。" },
					reply: { type: "string", description: "Leader 的最终回复内容。" },
					partnerName: { type: "string", description: "实际执行的 Partner 名称（如已知）。" },
					note: { type: "string" },
				},
				required: ["state", "leader", "reply"],
				additionalProperties: false,
			},
			render(_args, value) {
				const lines = [];
				if (value.reply) lines.push(`[ACPs Leader「${value.leader}」回复]\n${value.reply}`);
				if (value.partnerName) lines.push(`(由 Partner「${value.partnerName}」执行)`);
				if (value.note) lines.push(`(备注: ${value.note})`);
				return [{ type: "text", text: lines.filter(Boolean).join("\n") }];
			},
		},
		async execute(args, exec) {
			// Reuse the DSH agent's session id so multi-turn conversations stay
			// continuous with the remote leader; fall back to a fresh id.
			const agentSessionId = exec?.agent?.session?.id;
			const sessionId = typeof agentSessionId === "string" && agentSessionId !== ""
				? agentSessionId
				: `dsh-session-${createHash("sha256").update(String(Math.random())).digest("hex").slice(0, 16)}`;
			try {
				const outcome = await client.chat({ message: args.request, sessionId, signal: exec.signal });
				logger?.info?.("[acps] web-leader delegation settled", { leader: leaderCfg.id, state: outcome.state });
				return {
					state: outcome.state,
					leader: leaderCfg.name,
					reply: outcome.reply,
					...(outcome.partner?.name !== void 0 ? { partnerName: outcome.partner.name } : {}),
					...(outcome.reply === "" ? { note: "Leader 返回了空回复。" } : {}),
				};
			} catch (error) {
				logger?.warn?.("[acps] web-leader delegation failed", { leader: leaderCfg.id, error: String(error) });
				throw new Error(`ACPs Leader「${leaderCfg.name}」调用失败: ${error.message}`);
			}
		},
		isConcurrencySafe: () => false,
		timeoutMs: (leaderCfg.requestTimeoutMs ?? 60_000) + 15_000,
	};
}

/**
 * Create an AIP client for one partner descriptor.
 * `transport: "sdk"` uses the official acps-sdk through the Python bridge
 * (lib/sdk-bridge.js); anything else uses the built-in JS client (aip.js).
 * @param {object} partner - normalized partner config (endpoint, headers, transport).
 * @param {object} leader - { aic } leader identity.
 * @param {object} opts - { requestTimeoutMs, python, logger }.
 */
export function createClient(partner, leader, opts) {
	if (partner.transport === "sdk") {
		return new SdkBridgeClient({
			url: partner.endpoint,
			leaderId: leader.aic,
			python: opts.python ?? {},
			timeoutMs: opts.requestTimeoutMs ?? 30_000,
			logger: opts.logger,
		});
	}
	return new AipRpcClient({
		url: partner.endpoint,
		leaderId: leader.aic,
		headers: partner.headers ?? {},
		timeoutMs: opts.requestTimeoutMs ?? 30_000,
	});
}
