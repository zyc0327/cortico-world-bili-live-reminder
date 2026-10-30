# cortico-world-bili-live-reminder

关注 B 站主播的 UID，开播时让 Coo 在对话里提醒你。Cortico / Coopanion 的 World 扩展，契约 `cortico.api = 6`。

## 它做什么

- 在 World 页的「关注管理」面板里逐条新增/删除关注：输入一个 UID，点「新增」；列表显示昵称、直播间号与当前状态，点「删除」取消提醒。也可以在对话里让 Coo 用 `bili_live_follow` / `bili_live_unfollow` 增删。
- 默认每 60 秒用 B 站公开接口查一次关注主播的状态；间隔可在 30–600 秒之间调。
- 检测到「未开播 → 直播中」时，向主会话投一条 `bili-live-reminder.live` 事件；Coo 会在对话气泡里说一句，带主播名、本场开播时间、「直播间标题」和分区；直播间链接是否附带由开关决定。同一场直播只提醒一次；**同一主播下播后再开播算新的一场，会再次提醒**。
- 打开「启动时已在播也提醒」后，启动后的第一次检查会提示现在谁在播（`bili-live-reminder.startup`）；这个开关**默认打开**，运行中打开会在下一次检查补一条当前在播情况（`bili-live-reminder.current`）。提示语要求 Coo 用自然措辞，标题用「」括起来，不要出现「启动检查」「汇总」这类正式字眼。
- 「播报时附带直播间链接」默认打开，控制 Coo 的提醒、`bili_live_status` 和关注回执里是否带 `https://live.bilibili.com/<房间号>`；关闭时事件和回执会标注「播报链接已关闭」，提示词也禁止 Coo 从上下文补链接。面板列表始终显示房间号链接。
- `bili_live_status` 可以随时查关注列表、谁在播、上次检查时间和最近错误；传 `refresh: true` 立即查一次。
- 有 desktop-pet 时，提醒会尽量用 `pet_ask` 显示带「知道了」按钮的气泡；没确认时按配置重复提醒，点「知道了」或回复确认后停止。

提醒走 Coo 的对话，不是 Windows 系统通知；Coopanion 没开时不会有提醒。

## 关注管理面板

World 页上的「关注管理」面板（`src/webui/client.ts`，构建到 `dist/webui.js`）：

- **单条输入 + 新增**：输入主播 UID，按回车或点「新增」；支持 B 站 10 位旧 UID 和 16 位新 UID（例如 `3537115310721781`）。重复、非法 UID、找不到直播间都会在面板里提示。
- **列表**：每行显示昵称、UID、直播间号（可点开直播间）、直播中/未开播/未知；列表上方显示订阅数、检查间隔和上次检查时间，启动提醒关闭或待下次检查时会额外提示。
- **删除**：点「删除」并确认后，从 `worlds.bili-live-reminder.uids` 移除，不再提醒。
- **启动提醒**：默认开；如果被关掉，列表上方会提示「启动提醒已关（在「配置」里打开）」。
- 新增时服务端会先向 B 站查一次昵称与直播间号；面板打开时也会为还没有缓存的 UID 补查一次。

## 它不做什么

- 不登录 B 站，不读浏览器 cookie / SESSDATA，不需要任何 API Key。
- 不读或上传本机文件、剪贴板、屏幕；不写 `dataDir`。
- 不下载封面或头像，不发弹幕、不点赞、不关注 B 站账号里的任何人。
- 不包含下播提醒；下播不推事件。

## 网络与隐私

| 访问 | 地址 | 内容 |
|---|---|---|
| 批量状态 | `GET https://api.live.bilibili.com/room/v1/Room/get_status_info_by_uids?uids[]=…` | 关注列表里的 UID（公开数字） |
| 单 UID 兜底 | `GET https://api.live.bilibili.com/room/v1/Room/getRoomInfoOld?mid=<uid>` | 批量接口漏掉某个 UID 时查房间号与标题 |
| 昵称兜底 | `GET https://api.live.bilibili.com/live_user/v1/UserInfo/get_anchor_in_room?roomid=<roomId>` | 上一条拿到房间号后补昵称；失败时显示 `UID <uid>` |

请求只带 `User-Agent` 与 `Referer: https://live.bilibili.com/`，不带 cookie 或密钥。事件文本里的主播名、标题、分区来自 B 站，属于第三方文字；事件按外部来源投递，不会被当成内部指令。

## 配置项（`worlds.bili-live-reminder.*`）

| 键 | 默认 | 说明 |
|---|---|---|
| `uids` | `""` | 关注的主播 UID，最多 50 个；由「关注管理」面板或关注工具维护，不直接显示成文本框 |
| `pollIntervalSec` | `60` | 检查间隔，30–600 秒；从下一次检查起按新间隔运行 |
| `notifyAlreadyLiveOnStart` | `true` | 启动时已在播也发一条汇总；热开关，运行中打开会在下一次检查发「当前在播汇总」 |
| `includeRoomLink` | `true` | Coo 的播报与工具回执里是否附带直播间链接；面板列表不受影响 |
| `repeatCount` | `2` | 首次提醒之后最多再提醒几次：`-1` 无限，`0` 不重复，`1–10` 指定次数 |
| `repeatIntervalSec` | `300` | 未确认时两次重复提醒的间隔，30–3600 秒；在每轮检查时判断 |

## 工具

| 工具 | 作用 |
|---|---|
| `bili_live_status` | 只读：关注列表、各自状态、上次检查时间与错误；`refresh: true` 立即查 |
| `bili_live_follow` | 按 UID 关注；回执带主播名与当前是否在播 |
| `bili_live_unfollow` | 按 UID 取消关注 |
| `bili_live_ack` | 确认「知道了」：停止对一位或全部待确认提醒的重复 |

## 事件

| 类型 | 触发 | 说明 |
|---|---|---|
| `bili-live-reminder.live` | flush | 关注的主播从不播变直播中，或同一场换了开播时间 |
| `bili-live-reminder.startup` | flush | 启动后的第一次检查汇总已在播的主播；仅在开关打开时推出 |
| `bili-live-reminder.current` | flush | 运行中打开启动提醒后，下一次检查汇总当前在播的主播；不是刚刚开播 |
| `bili-live-reminder.repeat` | flush | 同一场开播在确认「知道了」之前的重复提醒；按 `repeatCount` / `repeatIntervalSec` 推出 |

## 「知道了」按钮与重复提醒

- 提醒优先通过 desktop-pet 的 `pet_ask` 显示成带选项的气泡，选项包含「知道了」；没有 `pet_ask` 时退回文字提醒。
- 用户点「知道了」或回复确认后，Coo 调用 `bili_live_ack`：单条带主播名/UID，汇总不带参数确认全部。
- 未确认时，World 在后续检查中按 `repeatCount` 和 `repeatIntervalSec` 发 `bili-live-reminder.repeat`；主播下播或确认后停止。
- 重复提醒依赖 Coo 按提示词调用 `pet_ask` 和 `bili_live_ack`；如果关闭了 desktop-pet，就只能用文字提醒和文字确认。

## 装进 Coopanion 试用（本机目录）

1. 打开 Coopanion 的「设置」→「高级模式」，再打开「扩展」页，点「手动安装」。
2. 选本机目录，填这个包在你机器上的绝对路径（例如 `D:\你的目录\cortico-world-bili-live-reminder`）。
3. 以链接（link）方式装入后，重启 Coopanion 进程。
4. 在「World 总览」里启用「B 站开播提醒」，打开它的页面。
5. 在「关注管理」面板输入主播 UID，点「新增」；列表里应出现昵称和直播间号。
6. 在对话里问 Coo「现在谁在播」，或让 Coo 关注一个 UID，确认工具链也通了。

npm 包名：`cortico-world-bili-live-reminder`。可以在扩展页搜索或手动填包名安装；上面的本机目录方式仍用于开发。

## 开发

```bash
corepack pnpm install
corepack pnpm build:webui   # 改过 src/webui/client.ts 后重新构建 dist/webui.js
corepack pnpm typecheck     # Node 侧 + 浏览器面板
corepack pnpm test          # 会先构建面板，再跑 vitest
corepack pnpm describe      # 改过工具、事件或环境提示词后重新生成 describe.json
```

测试全部使用假 `fetch`，不会请求 B 站。若本机有 Cortico 检出，还可以在检出根目录跑：

```bash
pnpm check:extension <包目录>
```

## 已知限制

- 轮询有最长一个间隔的延迟；默认 60 秒，最短 30 秒。进程启动后的首次检查会等约 5 秒，让主会话先就绪。
- 启动提醒只在进程启动或重新启用本 World 后的第一次检查发一次；运行中打开会补一条「当前在播汇总」。运行中不会重复汇总。
- 这些接口是 B 站网页端在用的公开接口，不是官方开放平台；字段或风控策略变化时可能失效。遇到 HTTP 412 或 code -352 会退避 10 分钟，并在 `bili_live_status` 里报告。
- 批量接口与昵称兜底都查不到昵称时，列表显示 `UID <uid>`；查不到直播间时显示「未找到直播间」。
- 面板新增时要求能查到直播间；如果 B 站暂时不可用，会提示查询失败，而不是写入一个无法验证的 UID。

## 许可证与素材

- 代码与图标：MIT，见 [LICENSE](LICENSE)。图标 `assets/icon.svg` 为本项目自绘，没有使用 B 站商标素材。
- B 站接口：由 Bilibili 提供，本扩展只按公开接口读取状态，不包含其代码或素材。
