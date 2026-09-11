# LLM Usage Limit Board

桌面小组件，显示每个 LLM 订阅的**实时用量**。每个订阅可选两种模式：

| 模式 | 适用场景 | 显示内容 |
| --- | --- | --- |
| **Coding Plan** | Claude Code / Cursor / OpenAI Codex / 包月套餐 | 5h 限额 % + 周限额 % |
| **余额（中转站）** | OneAPI / NewAPI / 自建中转 / 按量 API | 账户余额 |

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

首次启动会出现在屏幕右下角，拖标题栏可移动，点 ⚙ 添加订阅。

标题栏按钮：`_` 最小化、`⚙` 设置、`↻` 刷新、`×` 隐藏。窗口是无边框且不占任务栏的，所以**首次最小化/隐藏时会自动在系统托盘生成一个绿色圆点图标**——左键点击或右键菜单「显示看板」即可恢复，右键「退出」退出程序。

## 打 exe 分发

```bash
npm run dist:win
```

产物在 `dist/`：一个 NSIS 安装包，双击安装。

## 测试

```bash
npm test          # 无需窗口：报告条目回归 + 纯函数 + IPC 端到端（各自打印实际条数）
npm run test:dom  # 真实 Electron：渲染断言 + 托盘图标解码 + 截图（短暂创建隐藏窗口）
```

> 具体条数不写在这里——每轮都会变，写死了就等着漂。以命令输出为准。

- `test/report-items.test.js` —— 把评审报告里每一条要求编码成断言。**改代码后如果它变红，说明碰到了报告点过的行为。**
- `test/limits.test.js` —— 纯函数（限额/余额解析）的边界用例，含 `used/total` → 30 这类曾经算错的输入。
- `test/ipc.test.js` —— 用 stub `electron` 加载真实 `main.js`，直接调用 IPC handler 验证保存校验、`usage:fetch` 全链路、候选路径探测与窗口/托盘链路。
- `test/dom/` —— 真实 Electron 加载真实渲染层，覆盖恶意 id 注入、模式不一致、保存/加载失败横幅、托盘图标解码与渲染截图。

## 用量接口适配

不同服务商返回字段不一致。`src/lib/limits.js` 里的解析逻辑是启发式的：

- **Coding Plan 模式**：从 `/api/user/self` 等接口探测 5h / 周限额字段，关键词匹配（`five_hour` / `5h` / `quota_5h` / `weekly` / `week` / `seven_day` 等变体，支持 `used/total`、`used_percentage`、`"42%"` 三种形态），实现见 `detectLimitPct`
- **余额模式**：尝试 `/api/user/balance`、`/api/user/wallet`，再 fallback 到 `balance/remain/remaining/quota/credit` 字段；对 OneAPI/NewAPI 的 `quota`（单位：分）做了自动转换

如果你用的服务商字段名不一样，把那个接口的真实返回 JSON 贴给我（涂掉 key），我帮你改 `detectLimitPct / normalizeBalance`。
