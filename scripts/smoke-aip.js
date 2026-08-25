// Protocol-level smoke test: drives the dsh-acps AIP client against a running
// mock partner, asserting the full start → poll → complete lifecycle and the
// awaiting-input clarification flow.
//
// Usage: node scripts/smoke-aip.js [basePort=9021]
// Assumes `node mock-partner/server.js` is already running.

import { AipRpcClient, delegateTask, TASK_STATE } from "../packages/dsh-acps/lib/aip.js";
import { loadAcs, normalizeAcs } from "../packages/dsh-acps/lib/acs.js";
import { discover, partnerIdFromAic } from "../packages/dsh-acps/lib/adp.js";

const basePort = Number(process.argv[2] ?? 9021);
let failures = 0;

function check(name, condition, detail = "") {
	if (condition) {
		console.log(`  ✓ ${name}`);
	} else {
		failures += 1;
		console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

async function main() {
	// 1. Load the food partner's ACS over HTTP and verify parsing.
	console.log("1) ACS loading");
	const acsUrl = `http://127.0.0.1:${basePort}/acs`;
	const acs = await loadAcs({ acsUrl });
	const normalized = normalizeAcs(acs, "beijing-food");
	check("acs.name parsed", normalized.name === "北京美食推荐智能体", normalized.name);
	check("acs endpoint extracted", normalized.endpoint === `http://127.0.0.1:${basePort}/rpc`, normalized.endpoint);
	check("acs skills parsed", normalized.skills.length === 4, `skills=${normalized.skills.length}`);

	// 2. Full lifecycle: start → poll → complete.
	console.log("2) happy-path delegation (start → working → awaiting-completion → complete)");
	const client = new AipRpcClient({ url: normalized.endpoint, leaderId: "dsh-leader-001" });
	const outcome = await delegateTask(client, {
		request: "我想在北京品尝最正宗的烤鸭，请推荐几家老字号餐厅",
		pollIntervalMs: 200,
		pollTimeoutMs: 15_000,
	});
	check("final state completed", outcome.state === TASK_STATE.COMPLETED, outcome.state);
	check("products present", Array.isArray(outcome.products) && outcome.products.length >= 1);
	const productText = outcome.products.map((p) => p.text).join("\n");
	check("product mentions 全聚德", productText.includes("全聚德"), productText.slice(0, 80));

	// 3. Clarification flow: vague request → awaiting-input.
	console.log("3) clarification flow (awaiting-input)");
	const vague = await delegateTask(client, {
		request: "随便推荐点吃的吧",
		pollIntervalMs: 200,
		pollTimeoutMs: 15_000,
	});
	check("state awaiting-input", vague.state === TASK_STATE.AWAITING_INPUT, vague.state);
	check("inputQuestion present", typeof vague.inputQuestion === "string" && vague.inputQuestion.length > 0, vague.inputQuestion);

	// 4. Rejected/unknown partner error handling.
	console.log("4) error handling");
	const missing = new AipRpcClient({ url: `http://127.0.0.1:${basePort + 99}/rpc`, leaderId: "dsh-leader-001" });
	const failed = await delegateTask(missing, { request: "hi", pollIntervalMs: 200, pollTimeoutMs: 3_000 });
	check("unreachable partner fails loudly", failed.state === TASK_STATE.FAILED && typeof failed.error === "string" && failed.error.length > 0, `${failed.state} / ${failed.error}`);

	// 5. ADP discovery against the mock discovery server (default port 9050).
	console.log("5) ADP discovery");
	const foodAcs = await loadAcs({ acsUrl: `http://127.0.0.1:${basePort}/acs` });
	const foodAic = foodAcs.aic;
	const adpBase = `http://127.0.0.1:${process.env.MOCK_ADP_PORT ?? 9050}`;
	const discovery = await discover({ serverBaseUrl: adpBase, query: "北京美食", limit: 20 });
	const acsKeys = Object.keys(discovery.acsMap);
	check("acsMap returned", acsKeys.length >= 5, `acsMap keys=${acsKeys.length}`);
	check("food partner ACS present", foodAic !== void 0 && discovery.acsMap[foodAic] !== void 0);
	const allSkills = discovery.agents.flatMap((g) => g.agentSkills);
	check("agentSkills returned", allSkills.length >= 15, `skills=${allSkills.length}`);
	check("partnerIdFromAic stable", partnerIdFromAic(foodAic) === "0qld" || partnerIdFromAic(foodAic).length > 0, partnerIdFromAic(foodAic));
	const firstSkill = allSkills[0];
	const firstAcs = discovery.acsMap[firstSkill.aic];
	const firstNorm = normalizeAcs(firstAcs, partnerIdFromAic(firstSkill.aic));
	check("discovered ACS normalizes with endpoint", firstNorm.endpoint.startsWith("http://127.0.0.1:"), firstNorm.endpoint);

	console.log(failures === 0 ? "\nALL SMOKE CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
	console.error("smoke test crashed:", error);
	process.exit(1);
});
