# 群务台 · notice-hub 同步（com.expertkt.notice-hub）

把 [notice-hub（群务台）](https://github.com/ExpertKT/notice-hub) 的**待办、公告与截止时间**同步进 Trellora 日程：日/周/月/年视图、待办面板与提醒体系里直接看到群通知衍生的日程。

- 本仓库：<https://github.com/Trellora/NoticHubPlugin>（Trellora 插件独立分发仓库）
- 设计契约：Trellora 仓库 `docs/notice-hub-插件化与日程适配方案.md`（数据映射、事件总线、安全要求均以其为准）
- 数据流向：notice-hub（本机服务）→ 插件 → Trellora 日程库（`<workspace>/.menghan-meta/schedule/schedule.db`）。**数据仅存本机，不外传。**
- 同步方向：V1 仅单向（notice-hub → Trellora），不做回写；Trellora 内勾选完成不会回传 notice-hub。

## 1. 安装

### 1.1 从 zip 安装

1. 获取插件包 `notice-hub-<version>.zip`（内含 `plugin.json`、`main.js`、`lib/`、`LICENSE`、`LICENSE-UPSTREAM`、`NOTICE`、`README.md`）。
2. Trellora 设置 → 插件 → **安装** → 拖入 zip（或输入发布 URL）。
3. 阅读权限声明并确认：
   - `ui:command`（侧栏命令按钮）
   - `schedule:write`（写入日程，仅写本插件自己的条目）
   - `system:network`（访问本机/HTTPS 的 notice-hub 服务，L2 需显式授权）
   - `system:file`（读写插件自己的 storageDir 缓存，L2 需显式授权）
4. 安装完成后插件按 `onStartup` 自动激活；**默认 `enabled=false`，先配置再启用**（见 §2）。

### 1.2 开发目录安装

把本仓库根目录（含 `plugin.json`、`main.js`、`lib/` 与三份许可证文件）拷贝到 `~/.trellora/plugins/com.expertkt.notice-hub/`，重启 Trellora（或在插件管理中刷新）。

开发模式下可先跑自校验：

```bash
node scripts/validate-plugin-manifest.mjs .      # 清单校验（schema 见 scripts/plugin.schema.json）
node scripts/verify-notice-hub-plugin.mjs        # 单测 + 端到端（进程内 mock 群务台，92 断言）
node scripts/package-plugin.mjs                  # 打发布 zip（确定性构建 + 合规门）→ dist/
```

### 1.3 前置条件

- 已安装并启动 notice-hub 服务（默认 Web 端口 **8766**）。
- 若群务台设置了 `QQ_DIGEST_WEB_TOKEN`，需要在插件配置中填写同一令牌；未设置令牌时留空（空令牌仅允许本机环回访问）。

## 2. 配置项

配置经宿主设置面板下发（事件 `host:notice-hub:config`），插件侧做字段校验，非法值回退默认并给出中文警告。

| 配置项 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `false` | 同步开关。关闭时定时器停止、状态为「已禁用」 |
| `baseUrl` | string | `http://127.0.0.1:8766` | 群务台地址。仅允许环回 http 或公共 https，不允许带账号密码的 URL |
| `token` | string | `''` | 访问令牌（群务台 `QQ_DIGEST_WEB_TOKEN`）。可空；**仅经 `X-Token` 请求头传输，不落日志/缓存/状态** |
| `syncIntervalMinutes` | number | `15` | 自动同步间隔（分钟），有效范围 5–240 |
| `includeTodos` | boolean | `true` | 是否同步任务（待办/截止时间） |
| `includeNotices` | boolean | `false` | 是否同步公告（进日历易打扰，默认关） |
| `pruneMissing` | boolean | `false` | 远端消失的条目是否自动清理；关闭时保留本地条目不删除 |
| `categoryName` | string | `群务台` | 同步条目在日程里的分类名（默认色 `#0F766E`） |
| `reminderOffsetsMinutes` | number[] | `[1440, 0]` | 提醒提前量（分钟）：提前 1 天 + 到点；仅对有截止时间的条目生成 |

## 3. 使用

1. 在设置面板填好 `baseUrl` 与（可选）`token`，打开 `enabled` —— 插件立即同步一次，之后按 `syncIntervalMinutes` 自动同步。
2. 同步结果：
   - **待办**（`GET /api/tasks`）：进入日程待办面板，按「今天/本周/以后/无截止」分组；带截止时间的条目出现在日/周/月/年视图，按 `reminderOffsetsMinutes` 触发提醒。
   - **公告**（`GET /api/notices`，需 `includeNotices=true`）：生成全天事件，标题带「公告 · 」前缀。
   - 来源辨识：同步条目带 `notice-hub` 标签与「群务台」分类；待确认项带「待确认」标签，置顶项带「置顶」标签。
3. 侧栏命令（`contributes.uiCommands`）：
   - **同步群务台**（`notice-hub:sync-now`）：立即执行一次同步；失败不弹异常，错误进状态条。
   - **重置群务台缓存**（`notice-hub:reset-cache`）：清空 `storageDir/notice-hub-cache.json` 后全量重同步。
4. 状态（`plugin:notice-hub:status` → 设置面板）：`disabled / idle / syncing / ok / error`、最近同步时间、条目计数（todos/notices/skipped）、服务可达性、下次同步时间。
5. 行为约定：
   - 同步是**串行**的：同步中再触发会合并排队一次，不会并发写入。
   - **本地完成态优先**：Trellora 里已完成/已取消的条目，若远端仍是待办/待确认，同步只更新标题等字段、**不覆盖本地状态**（计入 `skipped`）。
   - **不碰用户手建日程**：插件只写自己的外部 ID 映射条目（`nh-task:*` / `nh-notice:*`）；删除的条目在 `pruneMissing=false` 时不会被重建（远端再次变化时按映射更新，属预期）。

## 4. 排障

| 现象 | 原因与处理 |
|---|---|
| **连不上服务**（状态报「无法连接群务台（…）：请确认群务台已启动」） | ① 确认群务台已启动（默认 <http://127.0.0.1:8766>）；② 核对 `baseUrl` 的地址与端口；③ 若群务台在别的机器上，请改用 https 公共地址（插件网络策略拒绝非环回 http）；④ 请求 10 秒超时会自动重试 3 次（退避 2s/4s/8s），仍失败则等下一轮自动同步 |
| **token 无效**（状态报「群务台鉴权失败（HTTP 401/403）」） | ① 核对令牌与群务台 `.env` 里的 `QQ_DIGEST_WEB_TOKEN` 完全一致（注意前后空格）；② 群务台未设令牌时**留空**令牌（空令牌仅允许本机环回）；③ 只经 `X-Token` 头传输，无需也不应把令牌拼进地址 |
| **同步不全** | ① `skipped` 计数表示被跳过的条目（本地完成态优先、字段解析失败）；② 群务台只把**带截止时间**的任务写进 `/calendar.ics`，且 `/api/tasks` 的收件箱（待确认收件箱）不进日程（V1 非目标）；③ 公告需显式打开 `includeNotices`；④ 确认 `includeTodos=true`；⑤ 若状态报「返回的数据无法解析」，插件会自动走 `.ics` 兜底，兜底也失败才报错 |
| 任务接口异常但日历订阅正常 | 插件在 `/api/tasks` 返回 404/5xx/非法 JSON 时自动改走 `/calendar.ics` 兜底（条目以 `nh-task:<UID>` 幂等 upsert） |
| 误删/想重建条目 | 用侧栏「重置群务台缓存」全量重同步；`pruneMissing=false` 时远端消失的条目不会被自动删除 |
| 权限被拒 | 插件需要 `system:network`（网络）与 `system:file`（缓存）两项 L2 授权；在插件管理里重新授权后重新启用 |

隐私说明：同步内容（群通知、待办）只写入本机工作区日程库与插件自身 storageDir 缓存；缓存与日志**均不含**访问令牌。

## 5. 署名与许可证

本插件包是两部分的组合，请注意各自的授权：

1. **上游项目 notice-hub（原名 qq-live-digest）**
   - 作者：**© wc985732-lang**，许可证 **MIT**（见 [`LICENSE-UPSTREAM`](LICENSE-UPSTREAM)）。
   - 本插件对接的 API/ICS 行为以其代码为事实来源；MIT 要求在再分发时保留版权声明与许可文本（已随包附带）。
2. **新增部分（ExpertKT 的 notice-hub 演进与本 Trellora 插件适配代码）**
   - 许可证 **PolyForm Noncommercial 1.0.0**（见 [`LICENSE`](LICENSE)）。
   - **个人与非商业用途免费**；**商业使用需事先取得书面授权**，请联系：**jkl2755908073@qq.com**。

再分发要求：须随包附带上文两份许可证文本与 [`NOTICE`](NOTICE) 声明；PolyForm Noncommercial 1.0.0 条款另要求附带许可方提供的以 `Required Notice:` 开头的明文行（如有）。本插件适配代码独立声明许可，不修改上游任何许可证文本；`LICENSE`、`LICENSE-UPSTREAM`、`NOTICE` 三份文件为原仓库逐字拷贝，请勿改动。
