/**
 * Session Shield — 让模型产出的畸形 tool call 不再污染会话日志。
 *
 * 背景：MiMo V2.6 Flash 曾输出过 id/name 为空字符串的 tool call（正文里还带着
 * `<tool_call>` 与 `<invoke` 混写的原始文本）。DSH 的**运行期校验不检查这两个字段**，
 * 事件照常写进 session.v4.jsonl.zstd；但**解码期**（dsh-session-format-v3-to-v4
 * 的 `text(block.id, "tool call id")`）要求非空字符串，于是日志一写进去就再也
 * 加载不出来，侧边栏只报 `tool call id requires a nonempty string`。
 *
 * 拦截点：DSH 官方的 `llm/stream` waterfall（`dsh-llm` 的 LlmRuntime.stream 注释
 * 原文 "possibly wrapped by llm/stream listeners"）。适配器路径与 prepareCall 路径
 * 都会经过 `streamWithRegistration`，所以这一个钩子覆盖全部模型调用。
 *
 * 修什么：
 *   - `block-end` 里 tool-call 的 `id` / `name` 为空 → 按 index 补合成 id、
 *     补占位工具名（占位名会走 DSH 已有的 `unknown tool "..."` 错误结果，
 *     模型收到反馈后自行重试，日志保持合法）。
 *   - `tool-call-delta` 同样补齐：BlockAssembler 在没有 block-end 时会用
 *     delta 累积值拼装，空 id 会原样漏过去（`?? 'call-N'` 只兜底 undefined）。
 *   - `arguments` 非字符串 → 转成 JSON 字符串，保证 assistant/message 里的
 *     块与随后的 tool/call 事件**逐字相同**（解码器要求两者完全一致）。
 *   - 同一次流内 id 重复 → 换新的合成 id（重复 id 会让解码报
 *     "assistant/message repeats advertised tool call"）。
 *
 * 不改的部分：正常 tool call 一个字节都不动。
 */
/** Cordis 插件名（Loader 诊断用）。 */
export const name = 'session-shield';

/** 依赖 llm 服务：既保证监听时服务已在，也把本插件放进正确的事件作用域。 */
export const inject = ['llm'];

/** 空 name 的替身工具名：DSH 对未知工具会返回 `unknown tool "..."` 错误结果。 */
const PLACEHOLDER_TOOL = 'guard_malformed_tool_call';

function isBlank(value) {
	return typeof value !== 'string' || value.length === 0;
}

function randomToken() {
	return Math.random().toString(16).slice(2, 8);
}

function synthId(state, index) {
	let id = `call-guard-${state.token}-${index}`;
	for (let n = 1; state.used.has(id); n += 1) id = `call-guard-${state.token}-${index}-${n}`;
	state.used.set(id, index);
	state.ids.set(index, id);
	return id;
}

/**
 * 同一个 index 的 delta 与 block-end 天然共用一个 id，不算重复；
 * 只有**不同 index** 复用同一 id 才会撞解码器的
 * "assistant/message repeats advertised tool call"。
 */
function claimId(state, id, index) {
	const owner = state.used.get(id);
	if (owner !== undefined && owner !== index) return false;
	state.used.set(id, index);
	state.ids.set(index, id);
	return true;
}

function argumentsText(value) {
	if (typeof value === 'string') return value;
	if (value === undefined || value === null) return '{}';
	try {
		return JSON.stringify(value) ?? '{}';
	} catch {
		return '{}';
	}
}

/**
 * 修一个 chunk；返回 `{ chunk, note }`，`note` 为 undefined 表示原样透传。
 *
 * @param chunk - 下游产出的原始 stream chunk（可能已被冻结，一律浅拷贝后改）
 * @param state - 本次流的合成 id 记忆（index → id / name，以及已用 id 集合）
 */
export function repairChunk(chunk, state) {
	if (chunk === null || typeof chunk !== 'object') return undefined;

	if (chunk.type === 'tool-call-delta') {
		let id = chunk.id;
		let name = chunk.name;
		let touched = false;
		if (isBlank(id) || !claimId(state, id, chunk.index)) {
			id = state.ids.get(chunk.index) ?? synthId(state, chunk.index);
			touched = true;
		}
		if (isBlank(name)) {
			name = state.names.get(chunk.index) ?? PLACEHOLDER_TOOL;
			touched = true;
		} else {
			state.names.set(chunk.index, name);
		}
		if (!touched) return undefined;
		return {
			chunk: { ...chunk, id, name },
			note: `tool-call-delta #${chunk.index} repaired (id="${id}", name="${name}")`
		};
	}

	if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') {
		const block = chunk.block;
		const notes = [];
		let id = block.id;
		let callName = block.name;
		if (isBlank(id) || !claimId(state, id, chunk.index)) {
			id = state.ids.get(chunk.index) ?? synthId(state, chunk.index);
			notes.push('id');
		}
		if (isBlank(callName)) {
			callName = state.names.get(chunk.index) ?? PLACEHOLDER_TOOL;
			notes.push('name');
		} else {
			state.names.set(chunk.index, callName);
		}
		const args = argumentsText(block.arguments);
		if (args !== block.arguments) notes.push('arguments');
		if (notes.length === 0) return undefined;
		return {
			chunk: { ...chunk, block: { ...block, id, name: callName, arguments: args } },
			note: `tool-call block #${chunk.index} repaired (${notes.join(', ')}) → id="${id}" name="${callName}"`
		};
	}

	return undefined;
}

/**
 * 包装下游 chunk 流，逐块修好坏掉的 tool call。
 *
 * @param source - `next()` 返回的下游 AsyncIterable
 * @param state - 本次调用的记忆状态
 * @param report - 每次修复的回调（通常接 ctx.logger.warn）
 * @returns 修好的 chunk 流
 */
export async function* guardStream(source, state, report) {
	for await (const chunk of source) {
		const fixed = repairChunk(chunk, state);
		if (fixed === undefined) {
			yield chunk;
			continue;
		}
		try {
			report?.(fixed.note);
		} catch {
			/* 日志失败不能影响模型调用 */
		}
		yield fixed.chunk;
	}
}

/**
 * Cordis 插件入口：在 `llm/stream` waterfall 最外层装上修复工。
 *
 * @param ctx - 插件上下文
 * @param config - 传入 `config.enabled = false` 可整体停用
 * @returns 卸载函数
 */
export function apply(ctx, config) {
	if (config?.enabled === false) {
		ctx.logger?.info?.('[session-shield] disabled by config');
		return undefined;
	}
	const off = ctx.on(
		'llm/stream',
		(options, next) => {
			const state = { token: randomToken(), ids: new Map(), names: new Map(), used: new Map() };
			const label = `${options?.provider ?? '?'}/${options?.model ?? '?'}`;
			return guardStream(next(), state, (note) => {
				ctx.logger?.warn?.('[session-shield] %s: %s', label, note);
			});
		},
		{ global: true, prepend: true },
	);
	ctx.logger?.info?.('[session-shield] armed on llm/stream');
	return () => {
		off?.();
		ctx.logger?.info?.('[session-shield] disarmed');
	};
}
