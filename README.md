# LLM Usage Limit Board

桌面小组件，显示每个 LLM 订阅的**实时用量**。每个订阅可选两种模式：

| 模式 | 适用场景 | 显示内容 |
| --- | --- | --- |
| **Coding Plan** | Kimi Code / OpenCode Go / Claude Code / Cursor / OpenAI Codex / 包月套餐 | 5h 限额 % + 周限额 % |
| **余额（中转站）** | OneAPI / NewAPI / 自建中转 / 按量 API | 账户余额 |

内置识别的服务商（都走 **Coding Plan** 模式，按下面填即可）：

| 服务商 | Base URL | API Key | 说明 |
| --- | --- | --- | --- |
| **Kimi Code** | `https://api.kimi.com/coding/v1`（填光主机 `https://api.kimi.com` 也可以） | Kimi **Code 控制台**的 Key（`sk-kimi-…`） | 不是 platform.moonshot.cn 开放平台的 `sk-` Key；Coding Plan 模式 |
| **OpenCode Go** | `https://opencode.ai/zen/go/v1` | OpenCode Go 的 API Key | 月度窗口暂无看板列，不显示 |
| **Moonshot 开放平台** | `https://api.moonshot.cn/v1` | 开放平台 Key（platform.moonshot.cn / .ai） | **余额模式**；按量计费显示账户余额，无 5h/周窗口 |
| OneAPI / NewAPI 网关 | 中转站根地址 | 网关 Key | 按网关返回的字段自动识别 |

## 隐私原则（多用户可放心使用）

- ✅ 所有订阅信息和 API Key **仅保存在本机**，加密方式：Windows DPAPI（`safeStorage`），其它用户/进程无法解密
- ✅ 程序**只在用户主动配置或自动刷新时**，向用户**自己填写的 Base URL** 发起一次请求；仅接受 `http` / `https` 协议，且**不跟随重定向**（30x 直接失败），所以请求不会被转跳到其它主机
- ✅ 填 `http://` 时设置面板会显示明文传输警告（API Key 会以明文上链），推荐使用 HTTPS
- ✅ 不出现在 `Base URL` 之外的任何网络出口；不内置任何分析/上报/自动更新
- ✅ 没有账号、没有云同步、没有远端配置
- ✅ 文件位置：`%APPDATA%/llm-usage-limit-board/providers.json`（想迁移或清除直接删这个文件）

源码中所有外发请求的入口**只有一个**：`src/main.js` 里的 `tryFetchJson`（`fetchOneAPIUserInfo` / `fetchBalanceUsage` 都经它发出）。
可以 `grep -n "fetch(" src/` 验证——除注释外只应命中一行。

## 启动

```bash
npm install
npm start
```

首次启动会出现在屏幕右下角，并先显示一次**隐私说明**（点「知道了」后不再出现，确认状态存在本机）；拖标题栏可移动，点 ⚙ 添加订阅。

标题栏按钮：`_` 最小化、`⚙` 设置、`↻` 刷新、`×` 隐藏。窗口是无边框且不占任务栏的，所以**首次最小化/隐藏时会自动在系统托盘生成一个图标（与挂件同构的三柱绿色图形）**——左键点击或右键菜单「显示看板」即可恢复，右键「退出」退出程序。

## 打 exe 分发

```bash
npm run dist:win
```

产物在 `dist/`：`LLM Usage Limit Board-<version>-Setup.exe`，双击安装（NSIS，可选安装目录、建桌面/开始菜单快捷方式）。

> **国内网络注意**：electron-builder 默认从 GitHub releases 取 NSIS / winCodeSign / Electron 包，`github.com` 不通时**不会报错，而是卡住不动**（表现为 `dist/win-unpacked` 建了个空目录后长时间无输出）。`npm run dist:win` 已经默认把镜像指到 npmmirror，想覆盖就自己设 `ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR`。
>
> **另一类打包失败**：如果报 `ENOENT: rename ...\win-unpacked\electron.exe`，说明解压 Electron 压缩包时那个 188MB 的主程序没落地（本机实测过：zip 里确实有 `electron.exe`，解压后其它文件都在、就它没有；杀软实时保护是最可能的原因）。`tools/dist.js` 会自动改为从已解包的 `node_modules/electron/dist` 复制，绕开解压——前提是 `build.electronVersion` 没有被显式指定（指定了就以你的为准，不覆盖）。

图标是代码生成的，不是二进制素材：

```bash
npm run icon     # 重新生成 build/icon.ico（7 种尺寸）+ src/assets/
```

## 测试

```bash
npm test          # 无需窗口：报告条目回归 + 纯函数 + IPC 端到端（各自打印实际条数）
npm run test:dom  # 真实 Electron：渲染断言 + 首次启动提示 + 托盘图标解码 + 截图
npm run test:tray # 真实 Electron + 真实 Tray：点托盘把窗口调回来
npm run test:all  # 上面三个依次跑
```

> 具体条数不写在这里——每轮都会变，写死了就等着漂。以命令输出为准。

- `test/report-items.test.js` —— 把评审报告里每一条要求编码成断言。**改代码后如果它变红，说明碰到了报告点过的行为。**
- `test/limits.test.js` —— 纯函数（限额/余额解析）的边界用例，含 `used/total` → 30 这类曾经算错的输入。
- `test/ipc.test.js` —— 用 stub `electron` 加载真实 `main.js`，直接调用 IPC handler 验证保存校验、`usage:fetch` 全链路、候选路径探测与窗口/托盘链路。
- `test/dom/` —— 真实 Electron 加载真实渲染层，覆盖恶意 id 注入、模式不一致、保存/加载失败横幅、托盘图标解码与渲染截图。

## 用量接口适配

不同服务商返回字段不一致。`src/lib/limits.js` 里的解析逻辑是启发式的：

- **Coding Plan 模式**：从 `/api/user/self` 等接口探测 5h / 周限额字段，关键词匹配（`five_hour` / `5h` / `quota_5h` / `weekly` / `week` / `seven_day` 等变体，支持 `used/total`、`used_percentage`、`"42%"` 三种形态），实现见 `detectLimitPct`
- **余额模式**：尝试 `/api/user/balance`、`/api/user/wallet`、`/api/user/quota`，再 fallback 到 `balance/remain/remaining/quota/credit` 字段。**数值原样显示，不做单位换算、不贴币种**——不同网关的 `quota` 有的是分、有的是元，猜错比不换算更糟（显示的是"多少钱"，不是百分比）

如果你用的服务商字段名不一样，把那个接口的真实返回 JSON 贴给我（涂掉 key），我帮你改 `detectLimitPct / normalizeBalance`。
