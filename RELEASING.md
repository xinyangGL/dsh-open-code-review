# Releasing

本仓库的发布纪律（M4）。每一条都是可核对的，不是口号。

## 一次 tag 只带一个高风险改动

「高风险」= 碰了宿主的扩展点（事件、服务、guard/waterfall 语义）、改了默认行为、动了与外部的
接口（`ocr` 命令行的 argv、`config.json` 的键、工具的返回值 schema）。

- 高风险改动单独占一个 tag，不和文档/文案/测试卫生混在一起 —— 出事时才能干净地回滚。
- 非高风险改动（文档、断言、纯重构）可以合并在同一版。
- 版本号按 SemVer：改默认行为 = 次版本号（例如 0.7.x → 0.8.0），只修缺陷 = 修订号。

## 挂新扩展点的版本，先在作者 profile 真机跑满 24 小时

真机跑的不是「能不能加载」，而是「日常用一天会不会出事」：

- 重启 DSH 后确认 `ocr_status` 报的版本/指纹是本版（真机加载证明）。
- 至少跑一次真实评审 + 一次失败路径（例如临时把 `timeoutMinutes` 调到 1）。
- 挂上新扩展点的那个进程要活过 24 小时再打 tag；期间出现过工具面异常就撤。

这一条来自 v0.5.7~v0.5.9 的教训：那三个版本用全局 `ctx.tools.guard()` 做闸门，放行时返回空字符串，
而宿主契约是「返回任意字符串 = 拒绝」⇒ **应用里每个工具都返回空的 `Error:`**，
持续约 5 小时且应用内无法自救（详见 `docs/pretest-gate-safety-design.md`）。事后补的三道防线是：
`lib/killswitch.js` 的应用外紧急制动、`lib/hooks.js` 的入口白名单 + 逐条 try/catch、
以及「可选功能不能拥有让整个工具面不可用的失败模式」这条设计原则。

## 出事的第一步：撤 tag / 发 hotfix

1. **先止血**：让用户把 `.disabled` 标记放到 `<DSH_HOME>/dsh-open-code-review.disabled`
   （或插件目录下的 `.disabled`），或设 `DSH_OPEN_CODE_REVIEW_DISABLE=1` 启动 DSH ——
   `ocr_status` 仍可用，其余钩子/命令/桥/skill 全不注册。
2. 需要退版本时删掉坏 tag 并在 CHANGELOG 里写明原因；不要用「悄悄重打同名 tag」的方式掩盖。
3. 修完发修订号版本，CHANGELOG 开头写清影响范围（哪些版本、什么症状、怎么自救）。
4. 回滚顺序：`preTest=off` → `enabled=false` → 降级到上一个 tag。

## 每个 tag 之前的检查清单

- [ ] `npm test` 八套离线全绿（smoke / killswitch-smoke / host-contract / job-smoke / reviewer-smoke /
      bridge-smoke / client-smoke / cordis-inject），CI 等价环境（藏掉 `ocr`）smoke 也全绿。
- [ ] `node --check lib/*.js` 通过；`lib/index.js` 里没有裸 `ctx.on(`（必须走 `armHook`）。
- [ ] `package.json` 的 `version` 与 `CHANGELOG.md` 顶部一致；改 `package.json` **只用编辑器/`edit` 工具**
      （PowerShell 的 `Set-Content` 会加 BOM，Node 会报 `Could not parse project manifest`）。
- [ ] `README.md` 与 `README.zh.md` 的断言计数、加固历史区间、目录树计数同步。
- [ ] 提交 → push → tag → GitHub Release → 等 CI 六 job 全绿（`tmp-ci-watch.mjs <sha>`）。
- [ ] 全新 profile 装卸验收：`dsh plugin --profile <tmp> add github:xinyangGL/dsh-open-code-review`，
      核对包内 `version` 与内容（**不含** `config.json`），然后 `remove` 并确认 profile 干净。

## 采用率与默认入口（14 天观测）

`ocr_status.stats.byEntry` 按入口记账（v0.9.0 起，**本次进程内**，重启清零；`since` 是开始时刻）：
`tool` / `command` / `button` / `auto` 四个桶，每桶 `started` / `ok` / `failed` / `lastAt` / `lastCode`。
判定规则（来自 CPO 评估 P1-1）：

- 连续两周 **按钮点击 0 次** ⇒ 说明「回合尾部按钮」这个默认入口的价值假设不成立，
  下一版把默认入口改成 `ocr_review` 工具 / skill，把按钮降级为可选。
- 某入口 `failed` 占比明显高于其它入口 ⇒ 先查该入口独有的失败路径（按钮：宿主 remote 命令；
  命令：注入的那句话模型有没有照着做），再决定是否改默认。

**为什么只有四个桶**：命令与按钮本身不执行评审（它们只是往会话里注入一句指令），入口只能在
「模型真的调 `ocr_review`」那一刻认领 —— 所以记账点在工具调用上。按钮靠命令行尾部的
`--entry=button` 标记与手输区分（插件收下即剥掉，不进提示词）；**没有 `skill` 桶**：模型自发调用
与按 on-demand skill 说明调用在工具层是同一次调用，分不出来，硬造一个桶就是猜。
评审先于测试（preTest）的提醒/拦截次数不在这个表里，`ocr_status.preTest` 单独报。

只数「评审跑了几次」而不记入口会丢掉这个判据，所以 `statusText` 里还会在按钮为 0 时直接写
「· 其中按钮 0 次」——不用自己去读 JSON。

## 远端与代理（本机环境备注）

本机 `github.com` 时好时坏。直连失败（`Recv failure: Connection was reset` /
`schannel: server closed abruptly`）时走本地 CONNECT 代理：

```powershell
Start-Process node C:\Users\吴礼凯\.dsh\tmp-gh-proxy.mjs   # 127.0.0.1:8899
git -c http.proxy=http://127.0.0.1:8899 -c http.version=HTTP/1.1 push origin main
```

Release 与 CI 查询脚本（`tmp-gh-release.mjs` / `tmp-ci-watch.mjs`）读
`C:\Users\吴礼凯\.dsh\tmp-gh-tok.txt`（40 字符 token，`git credential fill` 取 `password=`，
**等 CI 看完再删**）。提交中文消息一律先 `write` 到临时文件再 `git commit -F`（PowerShell 回显会乱码）。
