## 这个 PR 做了什么

<!-- 一句话说清「改了什么 + 为什么」。一个 PR 只做一件事。 -->

## 证据（必填）

<!-- 没有证据的「已修复」不接受。贴命令与输出： -->

- [ ] `npm test` 八套全绿（贴最后几行 / 计数）
- [ ] CI 等价环境（藏掉 `ocr`）的 smoke 也全绿
- [ ] 改了 UI / 真机行为：贴 `ocr_status` 片段或截图
- [ ] 改了默认行为 / 碰了宿主扩展点：附真机复验记录（重启后版本指纹 + 一次真实调用）

## 影响面

- 改了哪些默认值、哪些配置键、哪些返回值字段（用户会不会感知到）？
- 有没有碰到宿主扩展点？登记进 `docs/host-contract.md` 与 `lib/host-contract.js` 了吗？
- 新增了常驻行为吗？逃生通道是什么（`enabled=false` / `preTest=off` / `.disabled` / 环境变量）？
- 爆炸半径：这个改动出错时，影响它自己，还是整个工具面？

## 清单

- [ ] 没有新增运行时依赖（`lib/*.js` 只用 Node 内置模块）
- [ ] 注册事件走 `armHook`，没有裸 `ctx.on(`；handler 异常 fail-open
- [ ] 改了行为 ⇒ `CHANGELOG.md` + `README.md` + `README.zh.md` + `package.json` 版本 同步
- [ ] 改了断言数量 ⇒ README 两处 + CHANGELOG 的计数同步
- [ ] 高风险改动单独发版（见 `RELEASING.md`），没有和文档/文案混在一个 tag 里
- [ ] 没有为了过测试而放宽断言、删需求或改评分资产
