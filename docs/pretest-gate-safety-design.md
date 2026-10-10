# preTest 闸门安全重构方案

> 适用版本：dsh-open-code-review v0.5.9+
> 事故日期：2026-10-10
> 状态：**方案 B 已实现并发布（v0.6.0，2026-10-10）**；v0.5.10 先落地了最小热修复。
> v0.6.0 实际落点：`lib/index.js` 的 `createPreTest()` 只剩 `ctx.on("tools/pre-execute", …)` 一条注册路径
> （`gate()` 先 `SHELL_TOOLS` Set 查找 → `isTestCommand` → `preTestVerdict`，非 shell/非测试/off 一律 `next()`；
> `arm()` 里已无任何 `ctx.tools.guard()` 调用），`mechanism` 收敛为 `pre-execute`/`none`，
> `ocr_status.preTest` 增加 `failOpen`/`lastError`/`lastDecision`，并有源码级回归断言
> 「`lib/index.js` 里不再出现 `tools.guard(`」。第 7 节的测试矩阵与第 8 节的回滚顺序仍然适用。

## 1. 事故与根因

### 1.1 现象

桌面版 DSH 中，任意工具调用都返回内容为空的错误：

```text
Error: 
```

`pwsh`、`glob`、`acp_status`、`web_search` 全部失败；模型仍能发起工具调用，但执行层在统一入口把调用拒掉了。

### 1.2 触发链

1. 插件为了“评审先于测试”，在 `createPreTest()` 里注册了一个全局 `tools.guard(gate)`。
2. `gate()` 放行时返回空字符串 `""`，拒绝时返回理由字符串。
3. 宿主 `@deepseek-ai/dsh-tools` 的 guard 契约是：

   > Register a monotonic guard ... a returned string denies the execution.

   对应实现是“第一个 `!== undefined` 的返回值即拒绝”。因此 **空字符串不是放行，而是拒绝**。
4. 所有工具调用都会经过 guard 判定；非测试命令也被这个空字符串拒绝，最终统一渲染成 `Error: `。

### 1.3 关键代码路径

插件侧（修复前）：

```js
const gate = (exec) => {
  if (!isTestCommand(exec)) return "";
  const reason = preTestVerdict(safeCfg(), exec);
  if (reason) return reason;
  return "";
};

const registered = tools.guard(gate);
```

宿主侧：

```js
guardReason(exec) {
  for (const guard of this.guards.values()) {
    const reason = guard(exec);
    if (reason !== void 0) return reason;   // "" 也会在这里返回
  }
}

// prepareExecution 中：
const denialReason = decision.kind === "allow" ? this.guardReason(exec) : decision.reason;
if (denialReason !== void 0) {
  // 生成 text: `Error: ${denialReason}`
}
```

### 1.4 更本质的问题

空字符串只是导火索；真正危险的是把可选功能挂成了**全局 monotonic guard**：

- 对**所有工具**生效，而不是只对 shell/测试命令生效；
- guard 是单调的：第一个拒绝者获胜，后续 guard 无法翻案；
- guard 抛异常会进入工具执行管线的统一 catch，直接升级成所有工具报错；
- 与宿主契约的边界值（`""` / `undefined`）极易写错，且本地 fake ctx 测试未必能发现；
- `preTest=off` 时它也仍然挂着（为了热改配置），所以功能关闭并不能缩小爆炸半径。

## 2. 目标与非目标

### 2.1 目标

- 只影响“可能执行测试命令”的 shell 工具；读文件、联网、状态查询等工具必须零影响。
- 插件自身出错时，默认**不阻塞工具面**（fail-open），并在状态里可见。
- `preTest` 的 `off` / `remind` / `gate` 三档仍然可热切换，不需要重启 DSH。
- 行为可观测：能看出当前机制、拦截次数、放行次数、异常放行次数与最后一次决策。
- 行为可回归测试：直接复刻宿主的真实契约，而不是复刻插件的错误假设。

### 2.2 非目标

- 不把 preTest 当安全边界。它是工程流程辅助，不是“防止用户绕过评审”的强制机制。
- 不追求 100% 识别所有测试命令；识别不到时放行并记录，交由模型/用户判断。
- 不替代 CI、分支保护或提交钩子。

## 3. 方案对比

| 方案 | 机制 | 爆炸半径 | 强制力 | 结论 |
| --- | --- | --- | --- | --- |
| A. 保留全局 guard，只修 `""` | `tools.guard` | 全工具（monotonic） | 强 | 适合作为 v0.5.10 热修复，不作为长期方案 |
| B. 限定范围的 `tools/pre-execute` 拦截器 | waterfall 监听器 | 只有 shell 工具进入判定；非 shell 立即 `next()` | 中 | **推荐作为 v0.6.0 主方案** |
| C. 只提醒，不拦截 | `tools/result` + `agent.followup` | 零执行风险 | 弱 | 适合追求“绝不挡工具”的用户，作为 gate 的可选替代 |
| D. B + 一次性放行/白名单 | B + 显式逃生通道 | 同上 | 中 | 可在 B 稳定后追加 |

## 4. 推荐方案 B：限定范围的 pre-execute 拦截器

### 4.1 注册方式

不再调用 `ctx.tools.guard()`，只注册一个 `tools/pre-execute` waterfall 监听器：

```js
const dispose = ctx.on("tools/pre-execute", (exec, next) => {
  // 非 shell 工具：只做一次 Set 查找，立刻放行。
  if (!SHELL_TOOLS.has(String(exec?.name ?? ""))) return next();

  try {
    const cfg = safeCfg();
    const mode = preTestModeOf(cfg);

    // off / remind：放行；remind 只负责记 pending。
    if (!cfg || cfg.enabled === false || mode === "off") return next();
    if (mode === "remind") {
      preTestVerdict(cfg, exec);   // 只记 pending，不拦
      return next();
    }

    // gate：只有“确实像测试命令 + 没有评审覆盖”才拒绝。
    const reason = preTestVerdict(cfg, exec);
    if (reason) return { kind: "deny", reason };
    return next();
  } catch (err) {
    // 闸门自身异常一律 fail-open：宁可漏拦一次测试，也不能让工具面全挂。
    logRateLimited("warn", `preTest 闸门自身异常，已放行：${msgOf(err)}`);
    preTestTotals.failOpen += 1;
    preTestTotals.lastError = msgOf(err);
    return next();
  }
});
```

### 4.2 为什么是 `tools/pre-execute`

- 它的语义是 waterfall：每个监听器都可以 `next()` 把控制权交下去；放行不需要拼一个特殊返回值。
- 非 shell 工具在进入配置读取之前就 `next()`，性能和影响面都最小。
- 只有 `gate` 档且命中测试命令时才返回 `{kind:"deny", reason}`，拒绝理由会原样回到模型。
- 即使插件有 bug，最坏情况也只是“某条测试命令被误挡/漏挡”，而不是“所有工具都报错”。

### 4.3 生命周期

- 插件 `enabled=true`：监听器可以常驻，以保证 `config.json` 从 `off` 改成 `gate` 时无需重启即可生效。
- 插件 `enabled=false`：释放监听器，`mechanism=none`。
- 配置热切换：继续沿用现有的 `tools/result` + `agent/turn-stopping` 指纹同步；`off` 下监听器仍在，但只做一次 `SHELL_TOOLS` 判断后 `next()`。
- 如果未来希望 `off` 时连监听器都不挂，可以在 `sync()` 里按 `mode !== "off"` 装卸；代价是文件层改成 `gate` 后，必须等下一次同步事件才生效。两者取其一，建议先用“常驻 + 安全快路径”，因为它的风险已经由 fail-open 消除。

### 4.4 状态机

覆盖状态继续按 agent 维度维护：

- `reviewed=false`：初始/写工具成功后置 `false`；
- `reviewed=true`：`ocr_review` 成功且不是 preview 时置 `true`；
- `pending=true`：`remind` 档命中测试命令时置位；
- 测试结果返回：清 `pending`，注入提醒；
- 失败的 `ocr_review` 不置位；preview 不置位。

### 4.5 可观测性

`ocr_status.preTest` 增加字段：

```json
{
  "mode": "gate",
  "mechanism": "pre-execute",
  "denials": 3,
  "reminders": 1,
  "failOpen": 0,
  "lastDecision": { "tool": "pwsh", "kind": "deny", "at": 1791614776000 },
  "lastError": ""
}
```

日志需要限速：同一种闸门异常最多每 30 秒记一条，避免工具高频调用时刷屏。

### 4.6 逃生通道（可选，v0.6.x）

- 设置页提供 `preTest` 三档，默认 `off`；
- `gate` 档下，任何一次成功的 `ocr_review` 自动清闸；
- 可选加 `preTestAllowOnce` / `preTestAllowlist`，但不要做成静默绕过——所有放行都要在 `ocr_status` 里可见；
- 不建议用“按命令字符串匹配后永久放行”，容易产生白名单漂移。

## 5. 备选方案 C：只提醒，不拦截

如果用户希望“绝不挡工具”，可以只保留：

- `tools/result` 观察测试结果；
- `agent.followup()` 注入“这批改动还没评审”的提醒；
- 不做 `{kind:"deny"}`。

优点是零执行风险；缺点是模型可能忽略提醒。适合作为 `preTest=remind` 的正式语义，也是 `gate` 出问题时的降级档。

## 6. 落地路线

### v0.5.10（已完成的最小热修复）

- guard 放行返回 `undefined`，绝不返回 `""`；
- guard 与 waterfall 两条路径都加 try/catch，异常 fail-open；
- 新增“宿主契约回归”测试：直接复刻 `guardReason` 的 `!== undefined` 语义；
- 保留全局 guard，先恢复桌面版工具可用性。

### v0.6.0（推荐重构）

1. `createPreTest()` 移除 `ctx.tools.guard()` 分支，只使用 `tools/pre-execute`；
2. `mechanism` 状态收敛为 `pre-execute` / `none`；
3. 增加 `failOpen`、`lastDecision`、`lastError` 计数与 `ocr_status` 输出；
4. 更新 README / README.zh / CHANGELOG / config 注释中的 guard 描述；
5. 补齐测试矩阵（见第 7 节）；
6. 默认保持 `preTest=off`，`gate` 仍为显式开启。

### v0.6.x（可选）

- 一次性放行 / 显式 allowlist；
- 失败关闭选项 `preTest.failClosed=true`（默认 false），并在设置页明确标注“插件异常时会挡住测试命令”；
- 更细的测试命令识别：支持用户自定义命令正则，而不是只靠内置模式。

## 7. 测试矩阵

### 7.1 单元 / contract

- 宿主契约：`guardReason` 首个 `!== undefined` 即拒绝；放行必须是 `undefined`；
- 非 shell 工具：`glob` / `read` / `web_search` / `acp_status` 必须 `next()`；
- shell 非测试命令：`ls`、`echo`、`git status` 必须 `next()`；
- `gate` + 未评审 + `npm test`：必须返回 `{kind:"deny", reason}`，理由包含 `ocr_review`；
- 成功 `ocr_review` 后：同一批改动放行；
- 写工具之后：覆盖状态失效，再次测试被拦；
- preview 评审：不置 `reviewed=true`；
- 并发 / 重复询问：同 `callId` 只计一次 denial；
- 配置热切换：`off -> gate` 后无需重启即生效；
- 异常注入：`safeCfg()` 抛错、`preTestVerdict()` 抛错时必须 `next()`，且 `failOpen` 计数增加；
- dispose：释放监听器后不再参与判定。

### 7.2 集成 / 真机

- 桌面版 DSH：`pwsh`、`glob`、`acp_status`、`web_search` 各跑一次；
- `preTest=off`：测试命令正常执行；
- `preTest=remind`：测试命令放行，结果回来后收到提醒；
- `preTest=gate`：无评审时测试命令被挡；评审后放行。

### 7.3 性能

- 非 shell 工具的判定不得读取配置文件（只做一次 Set 查找）；
- shell 命令只在命中测试模式时才读配置；
- 日志限速。

## 8. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| waterfall 顺序导致其它监听器先拒绝 | 本插件只对测试命令 deny；顺序问题不会扩大成非测试工具故障 |
| fail-open 导致漏拦测试 | 这是有意的取舍：preTest 是流程辅助，不是安全边界；需要强约束时用 CI |
| 命令识别误判 | 识别不到时放行并记录；后续可提供自定义正则 |
| 配置热切换延迟 | 监听器常驻 + 指纹同步；必要时提供 `dsh plugin ... reload` |
| 宿主 API 变化 | 用真实 host 契约测试；禁止依赖“空字符串=放行”这类未文档化约定 |

回滚方式：

1. 设置页或 `config.json` 将 `preTest` 改为 `off`；
2. 仍不放行则把插件 `enabled` 设为 `false`；
3. 最后回退到 v0.5.10 的 guard 热修复版本。

## 9. 结论

- 立即修复：guard 放行返回 `undefined` + 异常 fail-open（v0.5.10，已完成）。
- 长期方案：把 preTest 从全局 monotonic guard 迁到限定范围的 `tools/pre-execute` 拦截器（v0.6.0）。
- 核心原则：**可选功能不能拥有“让全部工具不可用”的失败模式；任何插件内部错误都必须被限制在它自身的功能范围内。**