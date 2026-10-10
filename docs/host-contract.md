# 宿主契约（Host contract）

插件不是独立程序：它靠宿主（DSH）给的一组扩展点活着。这份文档把「用到了宿主的哪些能力、缺了会退化成什么样」写成一张可核对的清单，对应代码在 [`lib/host-contract.js`](../lib/host-contract.js)。

## 为什么需要它

v0.5.7~v0.5.9 出过一次事故：插件把 `ctx.tools.guard()` 的语义理解错了（放行时返回 `""`，而宿主的判定是「返回任何字符串都算拒绝」），结果**每一次工具调用都变成空内容的 `Error:`**，整个工具面不可用。当时没有任何地方能一眼看出「这个插件一共挂了哪些面、用的是哪些宿主接口」——事后复盘只有事故报告，没有清单。

所以 v0.7.0 起：

- 每个扩展点在 `HOST_CONTRACT.capabilities` 里占一条（`id` / `label` / `surface` / `required` / `detect` / `degrade`）；
- `ocr_status` 的 `host` 字段直接回放探测结果（做人可读的 `statusText` 里是「宿主能力」一行）；
- `test/host-contract.mjs` 逐条做「缺一」验证，并做**源码级防漂移**：`lib/index.js` 里出现的每个注册点 id 都必须登记在清单里，漏登记就测试红。

清单只描述**探测到的现实**，不做版本门（不写「必须 ≥ x.y.z」）：新宿主可能多给能力、少给事件，插件的行为应该跟着实际探测到的能力走，而不是跟着版本号猜。

## 清单

`surface` = `host` 表示宿主侧可以鸭子类型探测；`client` 表示只能在浏览器界面里由人确认。

### 必需（缺了插件等于没装，`ocr_status.host.ok` 变 `false`）

| id | 能力 | 缺了会怎样 |
| --- | --- | --- |
| `tools.register` | `ctx.tools.register` | `ocr_review` / `ocr_status` 不出现在工具列表，插件等于没装 |
| `subprocess.spawn` | `ctx.subprocess.spawn` | 跑不了 ocr：评审与 `ocr_status` 的定位都会失败 |

### 可选（缺了只少一块功能，其余照常）

| id | 能力 | 缺了会怎样 |
| --- | --- | --- |
| `subprocess.resolveExecutable` | `ctx.subprocess.resolveExecutable` | 只能靠 `ocrPath` 写绝对路径，PATH 上的 ocr 找不到 |
| `commands.register` | `ctx.commands.register` | 没有 `/ocr-review`；回合尾部按钮也点不动（按钮执行的就是它） |
| `credentials.resolve` | `ctx.credentials.resolve` | endpoint 模式的密钥只能来自 config.json 字面值或同名环境变量 |
| `events.tools/result` | `tools/result` | 自动评审不触发（工具与按需评审不受影响） |
| `events.agent/turn-stopping` | `agent/turn-stopping` | 会话空闲后不会补跑自动评审 |
| `events.tools/pre-execute` | `tools/pre-execute` | preTest 不生效（`ocr_status` 会报 `mechanism: none`） |
| `events.loader/volatile-update` | `loader/volatile-update` | 改设置页要等下一次工具调用/回合收尾才生效 |
| `inject.llm` | `ctx.llm.stream` | dsh 路由回落静态端点（要自己配 `baseUrl` + 密钥，且密钥会进 ocr 子进程） |
| `inject.jobs` | `ctx.jobs.start` | 没有 Jobs 面板的进度行（会话内进度行仍在） |
| `inject.skills` | `ctx.skills.register` | 没有按需评审 skill（按钮与 `ocr_review` 仍在） |
| `inject.subagents` | `ctx.subagents.start` | 「独立评审 agent」不可用，回落 ocr / delegate |
| `client.slots` | 设置页 / 插件卡片 / 回合尾按钮 / 输入框停靠 | 宿主侧探测不到（`present: null`）：界面里看不到就先刷新页面 |

## 怎么读

`ocr_status` 返回的 `host` 字段：

```json
{
  "ok": true,
  "missing": [],
  "errors": ["tools.register: 宿主服务访问器炸了"],
  "capabilities": [
    { "id": "inject.jobs", "label": "Jobs 服务（ctx.jobs.start）", "surface": "host", "required": false, "present": false, "degrade": "没有 Jobs 面板里的进度行（会话内进度行仍在）。" }
  ]
}
```

- `ok: false` + `missing` 非空 ⇒ 插件核心跑不起来，先解决那两个必需能力；
- `present: false` 的可选项 ⇒ 那一块功能不可用，`degrade` 里写了替代路径；
- `errors` 非空 ⇒ 探测本身报错了（按「缺这个能力」处理，绝不把插件带崩）；
- `present: null` 只出现在 `client.slots`（宿主侧看不到浏览器界面）。

`statusText`（`ocr_status` 的渲染结果）里对应「宿主能力」一行，例如：

```
- 宿主能力：宿主能力齐备（共 13 项宿主能力，客户端槽位未探测）
```

## 新增一个扩展点时要做什么

1. 在 `lib/host-contract.js` 的 `capabilities` 里加一条：`id` 用 `域.名字`（例如 `events.xxx` / `inject.xxx`），写清 `required`、`detect`（纯只读，抛错要能被兜住）、`degrade`（缺了用户还能怎么办）；
2. **先写探针**：确认宿主真的提供了这个接口、语义与你的假设一致（v0.5.7 那次就是「假设的语义」和宿主的实现相反）；
3. 如果是事件注册，事件名要同时登记进白名单（`lib/hooks.js` 的 `HOOK_WHITELIST`）——两处都不登记，测试会红；
4. 更新本文档的表格；
5. 跑 `node test/host-contract.mjs`（会做源码级扫描：`lib/index.js` 用到的 id 都必须登记）。

## 与爆炸半径的关系

清单回答「用了宿主的什么」；爆炸半径预算回答「这些挂载点出问题会不会拖垮别人」：每个钩子注册都必须经过 `armHook()`（白名单 + try/catch + 记账），可选服务注入必须经过 `safeInject()`（宿主没有 `ctx.inject` 或注入抛错都不许拖垮 `apply`），再加一个应用外的紧急制动（`DSH_OPEN_CODE_REVIEW_DISABLE` / 标记文件）。三件事一起，才让「可选功能的失败模式」被限制在它自己那块功能里。

## 兼容性声明与为什么不做版本门

实测环境（`lib/host-contract.js` 的 `HOST_CONTRACT.verifiedWith`，同时复制到 `package.json` 的 `dsh.host`）：

| 组件 | 实测值 |
| --- | --- |
| 宿主 | DSH `0.2.0-rc.2` 桌面版（2026-10-10 实测：本机 LLM 桥、`tools/pre-execute`、`jobs`、`skills`、`subagents` 均在） |
| Node | `>= 20`（CI 跑 20 / 22 / 24；本机实测 24.19.0） |
| `ocr` | Alibaba OpenCodeReview CLI `1.12.12`（必须单独安装；Windows 要原生 exe） |

`package.json` 里声明了：

```json
"dsh": { "host": { "dsh": ">=0.2.0", "testedWith": { "dsh": "0.2.0-rc.2 (desktop)", "node": "20 / 22 / 24", "ocr": "1.12.12" },
                    "capabilities": ["tools.register", "tools/pre-execute", "jobs", "llm", "slots", "remote.commands"] } }
```

**诚实说明**：宿主的插件清单只读 `dsh.bundle` / `dsh.profile`，以及 `dsh.client`（在 `@deepseek-ai/dsh-plugin-manager` 里核实过：只有 `manifest.dsh?.bundle` / `manifest.dsh?.profile` 被读取，没有对 `dsh` 下未知键的校验或拒绝）。所以 `dsh.host` 是**我们自己给人（和将来的市场）看的声明**，宿主不会因为版本不匹配拒绝加载 —— 这一点是故意的：

- 硬版本门会把「宿主多发了一个能力、少发了一个事件」这种真实差异变成「装不上」，而那种差异的正确处理方式恰恰是继续跑、然后把缺的东西报出来；
- 权威答案永远是运行期探测：`ocr_status.host` 说这台宿主实际给了什么，`ocr_status.hooks` 说插件实际挂上了什么，`ocr_status.preTest.mechanism` 说闸门到底有没有生效。三条都是「本机实测」，比任何版本号都准。

