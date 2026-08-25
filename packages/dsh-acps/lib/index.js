// dsh-acps — DSH ↔ ACPs bridge plugin.
//
// Turns a DSH profile into an ACPs **Leader**: it connects to ACPs Partner
// agents (statically configured or discovered through ADP), reads each
// partner's ACS (Agent Capability Specification), and registers every partner
// skill as a native DSH tool named `acps__<partnerId>__<skillId>`. The DSH
// model then delegates tasks to partners through the AIP protocol
// (direct-mode RPC: start → poll → complete) and aggregates their products.
//
// Cordis plugin shape (mirrors @deepseek-ai/dsh-mcp-client):
//   name, inject: ["tools"], Config (schemastery), async apply(ctx, config).

import z from "@deepseek-ai/schemastery";
import { loadAcs, normalizeAcs, extractRpcEndpoint } from "./acs.js";
import { discover, partnerIdFromAic } from "./adp.js";
import { createClient, createSkillTool, createDelegateTool, createDiscoverTool, createWebLeaderTool } from "./tools.js";

/** Cordis plugin name used by loader diagnostics. */
export const name = "acps";
/** Services required by this plugin. */
export const inject = ["tools"];

const PARTNER_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

const Leader = z.object({
	aic: z.string().default("dsh-leader-001"),
	name: z.string().default("DSH ACPs Leader"),
});

const Partner = z.object({
	id: z.string().required().pattern(PARTNER_ID_PATTERN),
	name: z.string().default(""),
	/** AIP transport: "js" (built-in client) or "sdk" (official acps-sdk via Python bridge). Empty inherits the plugin-level `transport`. */
	transport: z.string().default(""),
	/** Direct RPC endpoint; overrides the endpoint advertised in the ACS. */
	url: z.string().default(""),
	aic: z.string().default(""),
	/** Inline ACS object (first source consulted). */
	acs: z.any().default(null),
	/** Local ACS JSON file (relative paths resolve against the profile directory). */
	acsFile: z.string().default(""),
	/** HTTP(S) ACS JSON endpoint. */
	acsUrl: z.string().default(""),
	headers: z.dict(String).default({}),
	enabled: z.boolean().default(true),
	/** Per-partner overrides of the defaults below. */
	pollIntervalMs: z.number().min(100).default(2_000),
	pollTimeoutMs: z.number().min(1_000).default(300_000),
	completeOnAwaitingCompletion: z.boolean().default(true),
	requestTimeoutMs: z.number().min(1_000).default(30_000),
});

const Defaults = z.object({
	pollIntervalMs: z.number().min(100).default(2_000),
	pollTimeoutMs: z.number().min(1_000).default(300_000),
	completeOnAwaitingCompletion: z.boolean().default(true),
	requestTimeoutMs: z.number().min(1_000).default(30_000),
});

const Discovery = z.object({
	serverBaseUrl: z.string().default(""),
	/** Natural-language query sent to the discovery server at boot. */
	query: z.string().default(""),
	limit: z.number().min(1).default(10),
	headers: z.dict(String).default({}),
});

const Python = z.object({
	/** Python executable used to run the acps-sdk bridge. */
	command: z.string().default("python"),
	/** PYTHONPATH value pointing at the directory containing the acps_sdk package. */
	pythonPath: z.string().default(""),
	/** TCP port for the bridge; 0 picks a random free port. */
	port: z.number().min(0).max(65535).default(0),
});

const WebLeader = z.object({
	id: z.string().required().pattern(PARTNER_ID_PATTERN),
	name: z.string().default(""),
	/** Public chat endpoint of the ACPs leader (POST { session_id, message }). */
	url: z.string().required(),
	description: z.string().default(""),
	headers: z.dict(String).default({}),
	requestTimeoutMs: z.number().min(1_000).default(60_000),
});

export const Config = z.object({
	leader: Leader.default({}),
	defaults: Defaults.default({}),
	discovery: Discovery.default({}),
	partners: z.array(Partner).default([]),
	/** ACPs leaders reachable through their public web coordination API. */
	webLeaders: z.array(WebLeader).default([]),
	/** Default AIP transport for partners that do not declare their own. */
	transport: z.string().default("js"),
	/** acps-sdk bridge settings (used when a partner uses transport "sdk"). */
	python: Python.default({}),
	/** Reject plugin activation when any partner fails to initialize. */
	failOnStartupError: z.boolean().default(false),
});

/**
 * Activate the bridge: register the discovery tool (when configured), load
 * every partner's ACS, and register one tool per partner skill.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context with the tools service.
 * @param {object} config - resolved plugin config.
 */
export async function apply(ctx, config) {
	const logger = ctx.logger;
	const leader = { aic: config.leader.aic, name: config.leader.name };

	/** Live disposers; unregistered on plugin dispose/HMR. */
	let disposers = [];
	ctx.effect(() => {
		return () => {
			for (const dispose of disposers) dispose();
			disposers = [];
		};
	}, "acps.tools");

	const register = (definition) => {
		disposers.push(ctx.tools.register(definition));
	};

	// ADP discovery tool: lets the model ask the ecosystem what is available.
	if (typeof config.discovery.serverBaseUrl === "string" && config.discovery.serverBaseUrl !== "") {
		try {
			register(createDiscoverTool({ discovery: config.discovery, logger }));
			logger.info(`[acps] discovery tool registered (${config.discovery.serverBaseUrl})`);
		} catch (error) {
			logger.error(`[acps] discovery tool registration failed: ${String(error)}`);
			if (config.failOnStartupError) throw error;
		}
	}

	// ACPs leaders reachable through their public web coordination API.
	for (const leaderCfg of config.webLeaders) {
		try {
			register(createWebLeaderTool({ leaderCfg, logger }));
			logger.info(`[acps] web leader tool registered (${leaderCfg.id} -> ${leaderCfg.url})`);
		} catch (error) {
			logger.error(`[acps] web leader ${leaderCfg.id} registration failed: ${String(error)}`);
			if (config.failOnStartupError) throw error;
		}
	}

	const seenPartnerIds = new Set();
	const seenAics = new Set();
	const seenEndpoints = new Set();

	// One tool per statically-configured partner skill.
	for (const partnerCfg of config.partners) {
		if (partnerCfg.enabled === false) {
			logger.info(`[acps] partner ${partnerCfg.id} disabled, skipping`);
			continue;
		}
		try {
			const acs = await loadAcs({
				acs: partnerCfg.acs ?? void 0,
				acsFile: partnerCfg.acsFile || void 0,
				acsUrl: partnerCfg.acsUrl || void 0,
				headers: partnerCfg.headers ?? {},
				baseDir: ctx.root?.baseDir ?? process.cwd(),
			});
			const normalized = normalizeAcs(acs, partnerCfg.id);
			const endpoint = partnerCfg.url !== "" ? partnerCfg.url : normalized.endpoint;
			if (endpoint === void 0 || endpoint === "") {
				throw new Error('no RPC endpoint (configure "url" or advertise one in the ACS endPoints)');
			}
			const partnerId = partnerCfg.id;
			seenPartnerIds.add(partnerId);
			const partnerName = partnerCfg.name !== "" ? partnerCfg.name : normalized.name;
			const partnerAic = partnerCfg.aic !== "" ? partnerCfg.aic : normalized.aic;
			if (partnerAic !== "") seenAics.add(partnerAic);
			seenEndpoints.add(endpoint.replace(/\/+$/, ""));

			const opts = {
				pollIntervalMs: partnerCfg.pollIntervalMs,
				pollTimeoutMs: partnerCfg.pollTimeoutMs,
				completeOnAwaitingCompletion: partnerCfg.completeOnAwaitingCompletion,
				requestTimeoutMs: partnerCfg.requestTimeoutMs,
			};
			const transport = partnerCfg.transport !== "" ? partnerCfg.transport : config.transport;
			const client = createClient({ endpoint, headers: partnerCfg.headers ?? {}, transport }, leader, { ...opts, python: config.python, logger });

			const skills = normalized.skills;
			if (skills.length === 0) {
				register(createDelegateTool({ partnerId, partnerName, partnerAic, client, opts, logger }));
				logger.info(`[acps] partner ${partnerId} (${partnerName}) has no skills; registered whole-agent delegate tool`);
			} else {
				for (const skill of skills) {
					register(createSkillTool({ partnerId, partnerName, partnerAic, skill, client, opts, logger }));
				}
				logger.info(`[acps] partner ${partnerId} (${partnerName}) registered ${skills.length} skill tool(s) via ${endpoint}`);
			}
		} catch (error) {
			logger.error(`[acps] partner ${partnerCfg.id} failed to initialize: ${String(error)}`);
			if (config.failOnStartupError) throw error;
		}
	}

	// Auto-register partners returned by the ADP discovery server (in addition
	// to the statically configured ones). The leader can then call any agent
	// the ecosystem advertises without restarting.
	if (typeof config.discovery.serverBaseUrl === "string" && config.discovery.serverBaseUrl !== "") {
		try {
			const result = await discover({
				serverBaseUrl: config.discovery.serverBaseUrl,
				query: config.discovery.query !== "" ? config.discovery.query : "可用能力",
				limit: config.discovery.limit,
				headers: config.discovery.headers ?? {},
			});
			let discoveredCount = 0;
			for (const group of result.agents) {
				for (const agentSkill of group.agentSkills) {
					const acs = result.acsMap?.[agentSkill.aic];
					if (acs === void 0) continue;
					const partnerId = partnerIdFromAic(agentSkill.aic);
					const normalized = normalizeAcs(acs, partnerId);
					const endpoint = normalized.endpoint.replace(/\/+$/, "");
					if (endpoint === "") continue;
					// Skip agents already registered (by partnerId, AIC, or endpoint).
					if (seenPartnerIds.has(partnerId)) continue;
					if (normalized.aic !== "" && seenAics.has(normalized.aic)) continue;
					if (seenEndpoints.has(endpoint)) continue;
					seenPartnerIds.add(partnerId);
					if (normalized.aic !== "") seenAics.add(normalized.aic);
					seenEndpoints.add(endpoint);
					const partnerName = normalized.name;
					const partnerAic = normalized.aic;
					const opts = {
						pollIntervalMs: config.defaults.pollIntervalMs,
						pollTimeoutMs: config.defaults.pollTimeoutMs,
						completeOnAwaitingCompletion: config.defaults.completeOnAwaitingCompletion,
						requestTimeoutMs: config.defaults.requestTimeoutMs,
					};
					const client = createClient({ endpoint, headers: config.discovery.headers ?? {}, transport: config.transport }, leader, { ...opts, python: config.python, logger });
					if (normalized.skills.length === 0) {
						register(createDelegateTool({ partnerId, partnerName, partnerAic, client, opts, logger }));
					} else {
						for (const skill of normalized.skills) {
							register(createSkillTool({ partnerId, partnerName, partnerAic, skill, client, opts, logger }));
						}
					}
					discoveredCount += 1;
					logger.info(`[acps] discovered partner ${partnerId} (${partnerName}) registered ${normalized.skills.length} skill tool(s) via ${endpoint}`);
				}
			}
			logger.info(`[acps] ADP discovery registered ${discoveredCount} partner(s) from ${config.discovery.serverBaseUrl}`);
		} catch (error) {
			logger.error(`[acps] ADP discovery failed: ${String(error)}`);
			if (config.failOnStartupError) throw error;
		}
	}

	logger.info(`[acps] leader ${leader.aic} (${leader.name}) ready with ${disposers.length} tool(s)`);
}

export { extractRpcEndpoint as _extractRpcEndpoint };
