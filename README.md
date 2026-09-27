# Session Shield（dsh-session-shield）

DeepSeek Harness 插件：**让会话日志永远不会因为一次畸形 tool call（空 id / 空 name / 非法 arguments）而打不开**。
坏调用自动修复，正常调用原样通过，最多当轮报错，历史永远可加载。装上即用，零配置、零依赖、无需客户端改动。

## 解决什么问题

一次真实事故的链条：

1. 模型输出了 `id:""` / `name:""` 的 tool call（正文里还混着 `<tool_call>` 与 `<invoke` 两套调用语法）；
2. DSH **运行期**校验不检查这两个字段 → 事件照常写进 `session.v4.jsonl.zstd`；
3. **解码期**要求 tool call id 非空（`tool call id requires a nonempty string`）→
   这个会话从此加载不出来，侧边栏只剩 `stored session ... is corrupt`。

写入端宽松、读取端严格：坏事件一旦落盘就不可逆，只能手工修复日志。
本插件把这个口子堵在**落盘之前**。

## 怎么做

挂在 DSH 官方的 `llm/stream` waterfall（`dsh-llm`：*"the chunk stream, possibly wrapped by
`llm/stream` listeners"*），`prepareCall` 预绑定路径同样回到这里，所以**一个钩子覆盖全部模型调用**：

| 情况 | 处理 |
| --- | --- |
| `block-end` 里 tool-call 的 `id` 为空 / 本次流内被别的 index 复用 | 换成 `call-guard-<token>-<index>` |
| `block-end` 里 tool-call 的 `name` 为空 | 换成 `guard_malformed_tool_call` |
| `tool-call-delta` 的 `id` / `name` 为空 | 同样补齐（装配器在缺 `block-end` 时会用 delta 拼装） |
| `arguments` 不是字符串 | 转成 JSON 字符串，保证 message 块与随后的 `tool/call` 事件逐字一致 |
| **正常 tool call** | **原样透传，一个字节不动** |

空 name 换成占位工具名后走 Harness 已有的 `unknown tool "..."` 错误结果：模型收到反馈可以自行重试，
日志保持合法，会话照常可打开。

## 环境要求

- DeepSeek Harness 0.1.x（Web 端）
- 无额外依赖、无客户端代码、不写任何文件

## 安装

以下任一方式（插件管理器 `install_bundle`，或 设置 → 插件 的安装入口）：

1. **安装包（推荐分发）**：直接给出本 `.tgz` 的绝对路径
2. **源码目录**：解压源码 zip 后给出目录绝对路径
3. **registry 包名 / git 地址**：发布后用包名或仓库地址安装

安装成功后即在当前 profile 生效，**重启 DSH** 后插件层开始拦截。

## 配置

profile `cordis.patch.yml` 中本插件行的 `config`：

| 字段 | 说明 | 默认 |
| --- | --- | --- |
| `enabled` | 设为 `false` 整体停用（或直接注释掉 insert 行） | `true` |

## 验证是否生效

- `dsh --profile <profile> --dump-config` 的输出里应有 `# == dsh-session-shield` 层与
  `- id: session-shield` 行；
- 启动日志**不应**出现 `skipping profile bundle "dsh-session-shield"`；
- 启动审计 `warning: N entry did not activate` 里**不应**列出 `session-shield`；
- 设置 → 插件页里该条目状态为 active。

> 注：Harness 启动成功时不会把插件的 `ctx.logger` 输出打印到 `manager.log`
> （cordis logger 默认只进内存 buffer），所以看不到 "armed" 日志是正常现象，不代表未加载。

## License

MIT
