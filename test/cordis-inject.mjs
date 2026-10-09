/**
 * 真实 cordis 下的「服务注入 / 模型目录」回归测试。
 *
 * 守住两件事：
 * 1. cordis 的注入是全有全无：插件 inject 里只要有一个服务没人 provide，整个 fiber 就是 INACTIVE、
 *    apply 根本不跑（设置页整块消失）。所以插件本身只 inject ["slots"]，
 *    remote/remote.session 声明在 apply 内部的子 fiber 上 —— 缺服务时只是没有候选列表。
 * 2. 服务齐全时，子 fiber 里的 ctx 能按官方读法读到 `ctx.remote.session.modelCatalog()`；
 *    只差 remote.session 时子 fiber 不激活，但 `ctx.get("remote")` 兜底（第二条命）读得到。
 *
 * 依赖 DSH 自带的 cordis（asar 里取不出来，本仓库不 vendor）。取不到就跳过 ——
 * 跳过 ≠ 通过：跳过路径不打印「全部通过」，退出码也区分开
 * （0 = 全过，1 = 有断言失败，2 = 跳过、一条断言都没跑）。
 * OCR_TEST_CORDIS 认两种写法（也可以直接指 cordis 的目录）：
 * - 普通安装形态：…/node_modules/@deepseek-ai/cordis/lib/index.js
 * - asar 扁平形态：…/@deepseek-ai__cordis__lib__index.js
 * cosmokit 由 cordis 的落点推出来（同一次安装），不用另外指。
 */
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/* 必须走 fileURLToPath：用户名是中文时 URL.pathname 会留着百分号编码 */
const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const failures = [];
const check = (label, ok, detail = "") => {
  if (ok) console.log(`  ok   ${label}${detail ? "  :: " + detail : ""}`);
  else {
    failures.push(label);
    console.log(`  FAIL ${label}${detail ? "  :: " + detail : ""}`);
  }
};

/* ------------------------------------------------------------ 定位 cordis（取不到就跳过） */

const CORDIS_FLAT = "@deepseek-ai__cordis__lib__index.js";
const COSMOKIT_FLAT = "@deepseek-ai__cosmokit__lib__index.js";
const CORDIS_PLAIN = "@deepseek-ai/cordis/lib/index.js";
const COSMOKIT_PLAIN = "@deepseek-ai/cosmokit/lib/index.js";

/* 统一成正斜杠：可能粘的是 Windows 反斜杠路径，也可能是正斜杠路径。 */
const slashes = (p) => String(p).replace(/\\/g, "/");
const isFile = (p) => existsSync(p) && !statSync(p).isDirectory();

/**
 * 从 cordis 的 main 文件推出同一次安装里 cosmokit 的 main 文件。
 * 给的形态不固定，所以按候选挨个试，而不是要求某一种写法（评审 #1）。
 * 找不到返回 ""，调用方按「跳过」处理（别把 cordis 当 cosmokit 拷进去，
 * 那样会在 import 阶段报一个看不懂的模块解析错误）。
 */
function cosmokitFrom(cordisMain) {
  const norm = slashes(cordisMain);
  const candidates = [];
  if (norm.includes(CORDIS_FLAT)) candidates.push(norm.replace(CORDIS_FLAT, COSMOKIT_FLAT));
  if (norm.includes(CORDIS_PLAIN)) {
    const root = norm.slice(0, norm.indexOf(CORDIS_PLAIN));
    candidates.push(root + COSMOKIT_PLAIN); /* 提升安装：node_modules/@deepseek-ai/cosmokit */
    candidates.push(root + "node_modules/" + COSMOKIT_PLAIN); /* 嵌在 cordis 的 node_modules 下 */
  }
  const libDir = norm.slice(0, norm.lastIndexOf("/")); /* …/@deepseek-ai/cordis/lib */
  candidates.push(`${libDir}/../../cosmokit/lib/index.js`); /* 同 scope 兄弟目录 */
  candidates.push(`${libDir}/../../../@deepseek-ai/cosmokit/lib/index.js`); /* 提升到 node_modules */
  candidates.push(`${libDir}/../node_modules/@deepseek-ai/cosmokit/lib/index.js`); /* 嵌在 cordis 下 */
  return candidates.find((p) => isFile(p)) || "";
}

/** OCR_TEST_CORDIS 也允许直接指目录：补成它的 main 文件。 */
function cordisMainFrom(input) {
  const norm = slashes(input).replace(/\/+$/, "");
  return [norm, `${norm}/lib/index.js`, `${norm}/lib/index.mjs`, `${norm}/index.js`].find((p) => isFile(p)) || "";
}

const envInput = process.env.OCR_TEST_CORDIS || "";
const envCordis = envInput ? cordisMainFrom(envInput) : "";
if (envInput && !envCordis) {
  console.log(`跳过（本文件没有跑任何断言）：OCR_TEST_CORDIS 指的文件读不到 —— ${envInput}`);
  console.log("要的是 cordis 的 main 文件（…/@deepseek-ai/cordis/lib/index.js 或 asar 扁平形态 …/@deepseek-ai__cordis__lib__index.js），也可以是它的目录。跳过不代表通过。");
  process.exit(2);
}
if (envCordis && slashes(envCordis).includes("cosmokit")) {
  console.log(`跳过（本文件没有跑任何断言）：OCR_TEST_CORDIS 指的是 cosmokit —— ${envCordis}`);
  console.log("要的是 cordis 的 main 文件；cosmokit 会在同一次安装里自动找。跳过不代表通过。");
  process.exit(2);
}

const cordisFile =
  [envCordis, join(homedir(), ".dsh", "tmp-asar-shell", "dsh__node_modules__@deepseek-ai__cordis__lib__index.js"), join(homedir(), ".dsh", "tmp-asar-shell2", "dsh__node_modules__@deepseek-ai__cordis__lib__index.js")].find(
    (p) => p && isFile(p),
  ) || "";
/* 只校验"能不能拿到 cosmokit"，不再用 replace 的副产物当条件（评审 #2 那条死分支）。 */
const resolvedCosmokit = cordisFile ? cosmokitFrom(cordisFile) : "";

if (!cordisFile || !resolvedCosmokit) {
  console.log("跳过（本文件没有跑任何断言）：" + (cordisFile ? `在 cordis 旁边没找到 cosmokit：${cordisFile}` : "找不到 DSH 的 cordis（asar 里取不出来）"));
  console.log("设 OCR_TEST_CORDIS=<cordis 的 main 文件或它的目录> 后重跑。跳过不代表通过。");
  process.exit(2);
}

/* 把 cordis + cosmokit 摆成 node_modules 形状，裸导入 "@deepseek-ai/cosmokit" 才解析得到 */
const sandbox = await mkdtemp(join(tmpdir(), "ocr-cordis-"));
for (const [name, from] of [
  ["cordis", cordisFile],
  ["cosmokit", resolvedCosmokit],
]) {
  const dir = join(sandbox, "node_modules", "@deepseek-ai", name);
  await mkdir(join(dir, "lib"), { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: `@deepseek-ai/${name}`, version: "0.0.0-test", type: "module", main: "lib/index.js", exports: { ".": "./lib/index.js" } }),
  );
  await copyFile(from, join(dir, "lib", "index.js"));
}

/* ------------------------------------------------------------ 载入真实插件 + 真 cordis */

const { Context } = await import(pathToFileURL(join(sandbox, "node_modules", "@deepseek-ai", "cordis", "lib", "index.js")).href);

let descriptor;
globalThis.window = { __ModuleLoader__: { load: (d) => { descriptor = d; } } };
await import(pathToFileURL(join(PLUGIN_DIR, "lib", "client.js")).href);
/* 先证明 loader 契约真的生效，否则下面 descriptor.factory 会抛一个看不懂的 TypeError（评审 #9）。 */
const loaded = descriptor && typeof descriptor === "object" ? descriptor : null;
check(
  "client.js 通过 window.__ModuleLoader__.load 注册了 factory",
  Boolean(loaded) && typeof loaded.factory === "function",
  loaded ? `keys=${Object.keys(loaded).join(",")}` : String(descriptor),
);
if (!loaded || typeof loaded.factory !== "function") {
  console.log("\n1 项失败（后面的断言都要用 factory，先停）");
  await rm(sandbox, { recursive: true, force: true });
  process.exit(1);
}
const miniReact = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (v) => [v, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: (v) => ({ current: v }),
  useCallback: (fn) => fn,
};
const plugin = loaded.factory((spec) => {
  if (spec === "react") return miniReact;
  throw new Error(`client.js 依赖了额外模块：${spec}`);
});

const pluginInject = Array.isArray(plugin.inject) ? plugin.inject : [];
check(
  "插件 inject 只声明 slots（remote 在子 fiber 上，缺服务不会让插件 inactive）",
  pluginInject.includes("slots") && !pluginInject.includes("remote") && !pluginInject.includes("remote.session"),
  JSON.stringify(plugin.inject),
);

const envelope = {
  ok: true,
  value: {
    groups: [{ id: "commandcode", name: "Command Code", models: [{ id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek v4.1 Flash" }] }],
  },
};
/* 服务由一个独立 fiber provide（与真实 DSH 同形：remote 不是根上的，而是别的插件提供的） */
const remoteValue = { session: { modelCatalog: async () => envelope } };

/** 起一套根 Context，按宿主形态 provide 服务（slots/configForms 永远有，remote 可有可无）。 */
async function makeHost(services) {
  const root = new Context();
  const registrations = [];
  await root.plugin({
    name: "probe-provider",
    apply(ctx) {
      ctx.provide("slots", {
        inject(_name, cb) {
          cb();
        },
        register(options, component) {
          registrations.push({ options, component });
          return () => {};
        },
      });
      ctx.provide("configForms", { get: () => null });
      if (services.includes("remote")) ctx.provide("remote", remoteValue);
      if (services.includes("remote.session")) ctx.provide("remote.session", remoteValue.session);
    },
  });
  return { root, registrations };
}

/** 把插件挂上去，从它注册的 cell 里取回 cordis 真正给它的 scoped ctx 与子 fiber 的 remoteScope。 */
async function mount(host, tag) {
  host.registrations.length = 0;
  await host.root.plugin({ name: `probe-${tag}`, apply: plugin.apply, inject: plugin.inject });
  const reg = host.registrations.find((r) => r.options && r.options.name === "plugins.bundle.config");
  const element = reg ? reg.component({ view: "page" }) : null;
  const props = (element && element.props) || {};
  return { scoped: props.ctx || null, scope: props.remoteScope || null, cells: host.registrations.length };
}

/** 子 fiber 的激活是异步的：给它几个宏任务。 */
const settle = async (rounds = 6) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 1));
};

/* 形态 A：服务齐全（真实 DSH 的样子） */
const full = await makeHost(["remote", "remote.session"]);
const a = await mount(full, "full");
check("服务齐全时插件激活并注册两个 cell", a.cells === 2 && Boolean(a.scoped), `cells=${a.cells}`);
await settle();
check("子 fiber 在真 cordis 下激活", Boolean(a.scope && a.scope.current()), a.scope ? String(a.scope.current()) : "没有 remoteScope");
if (a.scope && a.scope.current()) {
  const authorized = await a.scope.current().remote.session.modelCatalog();
  check("官方读法 ctx.remote.session.modelCatalog() 读得到信封", authorized === envelope || (authorized && authorized.ok === true));
}
const rawRead = (() => {
  try {
    return { ok: true, value: a.scoped.remote };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
})();
check(
  "未声明 inject 的 ctx 上属性访问仍被守卫拦下（用户报的原文）",
  rawRead.ok === false && rawRead.error === 'cannot get property "remote" without inject',
  rawRead.ok ? "(居然读到了)" : rawRead.error,
);
/* 与形态 B/C 的写法对齐：先确认拿到 scoped ctx，别让 TypeError 顶掉后面的断言（评审 #4）。 */
const aFallback = a.scoped && typeof a.scoped.get === "function" ? a.scoped.get("remote") : undefined;
check('同一个 ctx 用 ctx.get("remote") 也读得到（子 fiber 未激活时的第二条命）', Boolean(aFallback), String(aFallback));

/* 形态 B：有 remote、没有 remote.session —— 子 fiber 不激活，兜底读取口就是活的 */
const half = await makeHost(["remote"]);
const b = await mount(half, "half");
check("缺 remote.session 时插件照样激活（插件级 inject 里没有它）", b.cells === 2 && Boolean(b.scoped), `cells=${b.cells}`);
await settle();
check("子 fiber 保持不激活", Boolean(b.scope) && b.scope.current() === null, b.scope ? String(b.scope.current()) : "没有 remoteScope");
const fallback = b.scoped && typeof b.scoped.get === "function" ? b.scoped.get("remote") : undefined;
check('兜底读取口 ctx.get("remote") 读得到（降级路径确实是活的）', Boolean(fallback && fallback.session && typeof fallback.session.modelCatalog === "function"));
if (fallback && fallback.session && typeof fallback.session.modelCatalog === "function") {
  const rescued = await fallback.session.modelCatalog();
  check("兜底路径同样解析得动 RemoteResult 信封", rescued === envelope || (rescued && rescued.ok === true));
}

/* 形态 C：完全没有 Remote 桥 —— 插件不能因此 inactive，设置页还得在（只剩手输降级） */
const bare = await makeHost([]);
const c = await mount(bare, "bare");
check("完全没有 remote(.*) 时插件照样激活并注册两个 cell", c.cells === 2 && Boolean(c.scoped), `cells=${c.cells}`);
await settle();
check("完全没有 remote 时子 fiber 不激活", Boolean(c.scope) && c.scope.current() === null, c.scope ? String(c.scope.current()) : "没有 remoteScope");
check('完全没有 remote 时 ctx.get("remote") 也读不到（只剩手输降级）', Boolean(c.scoped) && c.scoped.get("remote") === undefined, String(c.scoped && c.scoped.get("remote")));

/* ------------------------------------------------------------ 宿主侧 apply：可选服务缺席也不能 inactive */

const host = await import(pathToFileURL(join(PLUGIN_DIR, "lib", "index.js")).href);

/**
 * 起一套根 Context，按宿主形态 provide 宿主服务的替身：
 * tools / commands / subprocess / credentials 是插件 inject 里点名的（必须有），
 * subagents 是可选服务 —— 只由插件内部的子 fiber 声明，缺它时插件本体必须照常激活。
 * list() 的契约照真实实现抄：dsh-subagent 的 SubagentService.list() 返回 provider 名数组。
 */
async function makeHostPlugin(services) {
  const root = new Context();
  const registered = { tools: [], commands: [] };
  const calls = { subagentsList: 0 };
  await root.plugin({
    name: "host-probe-provider",
    apply(ctx) {
      ctx.provide("tools", {
        register(def) {
          registered.tools.push(String((def && def.name) || ""));
          return () => {};
        },
      });
      ctx.provide("commands", {
        register(def) {
          registered.commands.push(String((def && def.name) || ""));
          return () => {};
        },
      });
      ctx.provide("subprocess", {
        spawn() {
          throw new Error("探针不该真的起子进程");
        },
      });
      ctx.provide("credentials", {
        resolve: async () => ({ value: "" }),
      });
      if (services.includes("subagents")) {
        ctx.provide("subagents", {
          list() {
            calls.subagentsList += 1;
            return ["spawn"];
          },
          getProvider: () => undefined,
          start: async () => {
            throw new Error("探针不该真的起子 agent");
          },
          interrupt: () => {},
        });
      }
    },
  });
  await root.plugin({
    name: "host-probe-plugin-" + (services.join("+") || "bare"),
    apply: host.apply,
    inject: host.inject,
  });
  return { root, registered, calls };
}

/* 形态 D：宿主没提供 subagents / llm（老版 DSH，或没装 subagent 插件） */
const bareHost = await makeHostPlugin([]);
await settle();
check(
  "宿主没提供 subagents/llm 时插件照样激活并注册两个工具 + 一条命令",
  bareHost.registered.tools.length === 2 && bareHost.registered.commands.length === 1,
  `tools=${bareHost.registered.tools.join(",")} commands=${bareHost.registered.commands.join(",")}`,
);
check(
  "没有 subagents 时插件不会去碰它（list() 一次都没调）",
  bareHost.calls.subagentsList === 0,
  `list=${bareHost.calls.subagentsList}`,
);
check(
  "宿主侧 inject 不硬依赖 subagents/llm（写进去会让缺服务的 profile 打成 inactive）",
  !host.inject.includes("subagents") && !host.inject.includes("llm"),
  host.inject.join(","),
);

/* 形态 E：宿主提供了 subagents —— 子 fiber 激活并绑定服务 */
const fullHost = await makeHostPlugin(["subagents"]);
await settle();
check(
  "提供了 subagents 时子 fiber 激活（确实读了一次 list()）",
  fullHost.calls.subagentsList >= 1,
  `list=${fullHost.calls.subagentsList}`,
);
check(
  "提供 subagents 时插件本体依然注册两个工具 + 一条命令",
  fullHost.registered.tools.length === 2 && fullHost.registered.commands.length === 1,
  `tools=${fullHost.registered.tools.join(",")} commands=${fullHost.registered.commands.join(",")}`,
);
check(
  "注册的工具名就是 ocr_review / ocr_status，命令是 ocr-review",
  fullHost.registered.tools.join(",") === "ocr_review,ocr_status" && fullHost.registered.commands.join(",") === "ocr-review",
  `tools=${fullHost.registered.tools.join(",")} commands=${fullHost.registered.commands.join(",")}`,
);

await rm(sandbox, { recursive: true, force: true });
console.log(failures.length === 0 ? "\n全部通过" : `\n${failures.length} 项失败`);
process.exit(failures.length === 0 ? 0 : 1); /* 跳过走 2（见文件头） */
