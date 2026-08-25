// Generates mock partner directories under ./partners from a compact spec.
// Re-runnable: overwrites acs.json and mock.json for the listed partners.
// Run: node generate-partners.mjs

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "partners");
const BASE_PORT = 9021;

/** Skill helper: builds one ACS skill entry. */
function skill(id, name, description, tags = [], examples = []) {
	return {
		id,
		name,
		description,
		version: "1.0.0",
		tags,
		examples,
		inputModes: ["text/plain"],
		outputModes: ["text/plain", "application/json"],
	};
}

/** Partner spec → files. */
const PARTNERS = [
	{
		id: "beijing-food",
		name: "北京美食推荐智能体",
		aic: "1.2.156.3088.1.1.D55UOU.NEBZUA.1.0QLD",
		description: "根据用户口味偏好、行程和（可选）交通锚点推荐北京全境（城区+郊区）餐饮与特色美食。范围：仅限北京餐饮。",
		awaitInputPattern: "随便|不知道吃什么|帮我看看",
		inputQuestion: "请问您想品尝什么类型的北京美食（如烤鸭、小吃、老字号）？大概在哪个区域或靠近哪个景点？",
		productTemplate: "【北京美食推荐】根据您「{{request}}」的需求，为您推荐：\n1. 全聚德（前门店）—— 经典挂炉烤鸭，人均 150-200 元，建议提前一天预订。\n2. 东来顺（王府井店）—— 铜锅涮肉，人均 120-180 元。\n3. 护国寺小吃（总店）—— 豆汁、焦圈、艾窝窝等老北京小吃，人均 30-50 元。\n（价格为演示估算，实际以门店为准。）",
		skills: [
			skill("beijing_catering.traditional-food-recommendation", "传统美食推荐", "推荐北京传统美食和老字号餐厅，包括烤鸭、炸酱面、豆汁、爆肚等经典北京菜品。", ["传统美食", "老字号", "北京烤鸭"], ["我想在北京品尝最正宗的烤鸭，请推荐几家历史悠久的老字号餐厅"]),
			skill("beijing_catering.location-based-restaurant-recommendation", "位置匹配餐厅推荐", "根据用户当前位置或旅游路线推荐附近的餐厅，优化用餐时间和路线安排。", ["位置匹配", "就近用餐"], ["我明天上午要去故宫游览，中午想在附近找一家不错的餐厅吃午饭"]),
			skill("beijing_catering.dietary-preference-matching", "口味偏好匹配", "根据用户的饮食偏好、忌口要求和口味特点推荐合适的美食和餐厅。", ["口味偏好", "饮食禁忌"], ["我是素食主义者，想在北京找几家做得不错的素食餐厅"]),
			skill("beijing_catering.food-culture-experience", "美食文化体验", "介绍北京美食的历史文化背景，提供深度的文化体验和知识分享。", ["文化体验", "美食历史"], ["请详细介绍北京烤鸭的历史起源、制作工艺和文化意义"]),
		],
	},
	{
		id: "beijing-urban",
		name: "北京城区旅游智能体",
		aic: "1.2.156.3088.1.1.TTLIHU.LW9WCA.1.0N2P",
		description: "北京城区（东城、西城、朝阳、海淀等）景点推荐与行程规划，包括文化景点、亲子游、路线优化与预算规划。",
		productTemplate: "【北京城区景点推荐】根据「{{request}}」：\n推荐路线：上午故宫博物院（约3小时，门票60元）→ 中午景山公园登高俯瞰紫禁城 → 下午南锣鼓巷/什刹海漫步 → 傍晚前门大街。\n提示：故宫需提前7天在官网预约门票。",
		skills: [
			skill("beijing_urban.cultural-attraction-recommendation", "文化景点推荐", "推荐北京城区文化景点，如故宫、天坛、颐和园、恭王府等，并介绍游览要点。", ["文化景点", "故宫", "天坛"], ["请推荐北京城区最值得去的文化景点，并告诉我每个景点的游览时长"]),
			skill("beijing_urban.family-friendly-itinerary", "亲子游行程规划", "为亲子家庭规划北京城区行程，兼顾趣味性与体力安排。", ["亲子游", "家庭出行"], ["带5岁孩子玩北京3天，请规划城区亲子行程"]),
			skill("beijing_urban.urban-route-optimization", "城区路线优化", "根据景点分布优化城区游览路线，减少往返时间。", ["路线优化", "城区交通"], ["我想一天逛故宫、天坛、颐和园，请帮我优化路线"]),
			skill("beijing_urban.budget-conscious-planning", "预算规划服务", "按预算约束规划北京城区游览方案。", ["预算规划", "省钱"], ["预算500元玩北京城区一天，怎么安排"]),
		],
	},
	{
		id: "beijing-rural",
		name: "北京郊区旅游智能体",
		aic: "1.2.156.3088.1.1.1Z4AXU.YN86QQ.1.186L",
		description: "北京郊区（延庆、密云、怀柔、门头沟等）自然风光、小众景点与户外活动推荐。",
		productTemplate: "【北京郊区推荐】根据「{{request}}」：\n推荐：古北水镇（密云，1-2日，可夜游司马台长城）、雁栖湖（怀柔，环湖骑行）、金海湖（平谷，水上运动）、百花山（门头沟，高山草甸徒步）。\n交通提示：多数郊区景点建议自驾或乘坐市郊铁路。",
		skills: [
			skill("beijing_rural.natural-scenery-recommendation", "自然风光推荐", "推荐北京郊区自然风光目的地，如古北水镇、雁栖湖、金海湖等。", ["自然风光", "郊区"], ["北京郊区哪里自然风光好？请推荐2日游目的地"]),
			skill("beijing_rural.rural-itinerary-planning", "郊区行程规划", "规划北京郊区一日/两日行程，含交通与时间安排。", ["行程规划", "周末游"], ["周末从市区出发去郊区玩两天，请规划行程"]),
			skill("beijing_rural.hidden-gems-discovery", "小众景点发现", "发掘北京郊区小众、人少的景点。", ["小众景点", "人少"], ["北京郊区有哪些人少景美的小众景点"]),
			skill("beijing_rural.outdoor-activity-arrangement", "户外活动安排", "安排郊区徒步、骑行、露营等户外活动。", ["户外活动", "徒步", "露营"], ["北京郊区适合初学者的徒步路线有哪些"]),
		],
	},
	{
		id: "china-hotel",
		name: "全国酒店预订智能体",
		aic: "1.2.156.3088.1.1.CIQJUQ.HELDGD.1.03TO",
		description: "全国范围内酒店推荐、预订协助、住宿优化与价格比较。",
		productTemplate: "【酒店推荐】根据「{{request}}」：\n1. 北京王府井区域：王府井希尔顿（商务，¥1200/晚）、全季酒店（经济，¥450/晚）。\n2. 建议提前3-7天预订，节假日价格上浮20-30%。\n（价格为演示估算，实际以OTA实时为准。）",
		skills: [
			skill("china_hotel.hotel-recommendation", "酒店推荐服务", "根据位置、预算与偏好推荐酒店。", ["酒店推荐"], ["在北京王府井附近推荐性价比高的酒店"]),
			skill("china_hotel.reservation-assistance", "预订协助服务", "协助完成酒店预订流程与注意事项说明。", ["预订协助"], ["帮我看看预订酒店的注意事项"]),
			skill("china_hotel.accommodation-optimization", "住宿优化建议", "根据行程优化住宿地点与住宿安排。", ["住宿优化"], ["3天北京行程，住哪个区域最方便"]),
			skill("china_hotel.price-comparison", "价格比较服务", "比较同区域不同酒店的价格与性价比。", ["价格比较"], ["比较北京国贸附近三家酒店的价格"]),
		],
	},
	{
		id: "china-transport",
		name: "全国交通规划智能体",
		aic: "1.2.156.3088.1.1.8UDX9U.NNVB61.1.13WT",
		description: "全国范围城际交通规划、路线优化与特殊需求交通安排。",
		productTemplate: "【交通规划】根据「{{request}}」：\n建议方案：高铁（北京南→上海虹桥，4.5小时，二等座¥553）或飞机（大兴→虹桥，2.5小时，¥600-900）。\n市内接驳：地铁+打车组合通常最省时。\n（时刻与票价为演示估算。）",
		skills: [
			skill("china_transport.intercity-transportation-planning", "城际交通规划", "规划城市之间的交通方式（高铁/飞机/自驾）与时间。", ["城际交通", "高铁"], ["北京到上海最快的交通方式是什么"]),
			skill("china_transport.route-optimization", "路线优化服务", "优化多城市串联行程的交通路线。", ["路线优化"], ["北京-西安-成都-上海怎么串联交通最顺"]),
			skill("china_transport.special-needs-transportation", "特殊需求交通", "安排老人、儿童、无障碍等特殊需求交通。", ["特殊需求", "无障碍"], ["带老人出行，北京到青岛选什么交通方式"]),
		],
	},
];

for (const spec of PARTNERS) {
	const index = PARTNERS.indexOf(spec);
	const port = BASE_PORT + index;
	const dir = join(ROOT, spec.id);
	mkdirSync(dir, { recursive: true });
	const acs = {
		aic: spec.aic,
		active: true,
		lastModifiedTime: "2026-06-22T00:00:00.000000+08:00",
		protocolVersion: "02.01",
		name: spec.name,
		description: spec.description,
		version: "1.0.0",
		provider: { organization: "ACPs社区 (mock)", url: "https://ioa.pub" },
		endPoints: [
			{ url: `http://127.0.0.1:${port}/rpc`, transport: "JSONRPC", security: [{ mtls: [] }] },
		],
		capabilities: { streaming: false, notification: false, messageQueue: [] },
		defaultInputModes: ["text/plain"],
		defaultOutputModes: ["text/plain", "application/json"],
		skills: spec.skills,
	};
	const mock = {
		productTemplate: spec.productTemplate,
		...(spec.awaitInputPattern !== void 0 ? { awaitInputPattern: spec.awaitInputPattern, inputQuestion: spec.inputQuestion } : {}),
		timingsMs: { workingMs: 400, productMs: 1200 },
	};
	writeFileSync(join(dir, "acs.json"), JSON.stringify(acs, null, 2) + "\n", "utf8");
	writeFileSync(join(dir, "mock.json"), JSON.stringify(mock, null, 2) + "\n", "utf8");
	console.log(`generated partner ${spec.id} on port ${port}`);
}
console.log(`done: ${PARTNERS.length} partners under ${ROOT}`);
