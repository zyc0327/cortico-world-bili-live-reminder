/**
 * B 站开播提醒 World:按间隔轮询关注 UID 的公开开播状态,在「未开播 → 直播中」时
 * 向主会话投递一条提醒事件;同时提供查询、关注与取关工具。
 *
 * 不登录、不带 cookie、不读本机文件;只访问 api.live.bilibili.com 的两个公开接口。
 */
import { fileURLToPath } from 'node:url';
import type {
  ToolDef,
  ToolOutcome,
  World,
  WorldHost,
  WorldLamp,
  WorldWebUiDecl,
} from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';
import { nowIso } from 'cortico/core/util.ts';
import type { DeepPartial } from 'cortico/world.ts';
import {
  DEFAULT_POLL_SECONDS,
  MAX_FOLLOWED_UIDS,
  MAX_POLL_SECONDS,
  MIN_POLL_SECONDS,
  biliLiveReminderConfigGroup,
  type BiliLiveReminderConfigSection,
} from './config.ts';
import {
  fetchLiveSnapshots,
  parseUids,
  roomLink,
  serializeUids,
  type FetchLike,
  type LiveSnapshot,
} from './bilibili.ts';
import { text } from './strings.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

export const WORLD_ID = 'bili-live-reminder';

const UID_MAX = 4_294_967_295;
const DEFAULT_TIMEOUT_MS = 15_000;
/** 等进程/会话就绪后再做第一次检查,避免启动汇总在装配期丢掉。 */
const INITIAL_POLL_DELAY_MS = 5_000;

/** 全部工具的声明;定义里的 describe 与 `tools()` 都取它。 */
export const BILI_LIVE_REMINDER_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'bili_live_status',
    description:
      'Read the Bilibili live status of the streamers this World follows: whether each is live, the room title, the area and the room link, plus when the last check ran and any recent error. Use it when the user asks who is live, whether a followed streamer is live, or whether the reminder is working. Set refresh to true to query Bilibili right now instead of using the last result. This tool is read-only.',
    tags: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        refresh: {
          type: 'boolean',
          default: false,
          description: 'Query Bilibili now and wait for the result instead of using the last stored status.',
        },
        uid: {
          type: 'integer',
          minimum: 1,
          maximum: UID_MAX,
          description: 'Only show this followed UID. Omit to show every followed streamer.',
        },
      },
    },
  },
  {
    name: 'bili_live_follow',
    description:
      'Follow a Bilibili streamer by numeric UID so the World reminds the user when that streamer goes live. Only follow a UID the user explicitly asked for; never guess or follow someone on your own. Returns the streamer name and current live status when Bilibili answers, and adds the UID to the World config.',
    tags: ['write'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        uid: {
          type: 'integer',
          minimum: 1,
          maximum: UID_MAX,
          description: 'The numeric Bilibili user UID, for example 2. It is the number in the user space URL.',
        },
      },
      required: ['uid'],
    },
  },
  {
    name: 'bili_live_unfollow',
    description:
      'Stop following a Bilibili streamer by numeric UID. Use it only when the user asks to stop reminders for that UID. Returns how many streamers remain followed.',
    tags: ['write'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        uid: {
          type: 'integer',
          minimum: 1,
          maximum: UID_MAX,
          description: 'The numeric Bilibili user UID to remove from the follow list.',
        },
      },
      required: ['uid'],
    },
  },
];

export interface BiliLiveReminderOptions {
  /** `worlds.bili-live-reminder` 的活引用;每次轮询与每次读取现读。 */
  cfg: BiliLiveReminderConfigSection;
  timezone: string;
  /** 写回 `worlds.bili-live-reminder`;关注工具用它改 UID 列表。 */
  persist: (patch: DeepPartial<BiliLiveReminderConfigSection>) => void;
  /** 测试可替换的 fetch;缺省用全局 fetch。 */
  fetch?: FetchLike;
  /** 单次请求超时,毫秒。 */
  timeoutMs?: number;
}

type LookupResult =
  | { kind: 'found'; snapshot: LiveSnapshot }
  | { kind: 'not-found' }
  | { kind: 'error'; message: string };

type SummaryKind = 'startup' | 'current';

/** 关注管理面板里的一行。 */
export interface SubscriptionItem {
  uid: number;
  uname: string;
  roomId: number | null;
  /** null 表示还没有查到状态。 */
  live: boolean | null;
  title: string;
  area: string;
}

/** 关注管理面板的数据面。 */
export interface SubscriptionView {
  items: SubscriptionItem[];
  lastPollAt: string | null;
  lastError: string | null;
  lastWarnings: string[];
  pollIntervalSec: number;
  /** 当前实例启动时实际使用的值。 */
  notifyOnStart: boolean;
  /** 配置里已改、但当前实例还没重启时,两者不一致。 */
  notifyOnStartPending: boolean;
}

function toUid(value: unknown): number | null {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value.trim())
        : Number.NaN;
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= UID_MAX ? parsed : null;
}

export class BiliLiveReminderWorld implements World {
  readonly id = WORLD_ID;

  private readonly cfg: BiliLiveReminderConfigSection;
  private readonly timezone: string;
  private readonly persistConfig: (patch: DeepPartial<BiliLiveReminderConfigSection>) => void;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly timeoutMs: number;

  private host: WorldHost | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private abort: AbortController | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = true;

  /** 上一次成功检查的快照;查不到时保留旧值,不误报离线。 */
  private snapshots = new Map<number, LiveSnapshot>();
  /** 已建立基线的主播状态,用于判断「刚刚开播」。 */
  private baseline = new Map<number, LiveSnapshot>();
  private baselineReady = false;
  private lastPollAt: string | null = null;
  private lastError: string | null = null;
  private lastWarnings: string[] = [];
  private failures = 0;
  /** 启动时读一次;设置页说这项下次启动生效。 */
  private notifyOnStart = false;

  constructor(options: BiliLiveReminderOptions) {
    this.cfg = options.cfg;
    this.timezone = options.timezone;
    this.persistConfig = options.persist;
    this.fetchImpl = options.fetch;
    this.timeoutMs = Math.max(1_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  }

  envPromptVars(): Record<string, string> {
    return {
      'bili_live_reminder.intervalSeconds': String(this.intervalSeconds()),
      'bili_live_reminder.followedCount': String(this.uids().length),
      'bili_live_reminder.includeRoomLink': this.includeRoomLink() ? '开' : '关',
      'bili_live_reminder.notifyOnStart': this.cfg.notifyAlreadyLiveOnStart !== false ? '开' : '关',
    };
  }

  tools(): ToolDef[] {
    return [
      {
        ...BILI_LIVE_REMINDER_TOOL_DECLS[0],
        handler: (args) => this.statusTool(args),
      },
      {
        ...BILI_LIVE_REMINDER_TOOL_DECLS[1],
        handler: (args) => this.followTool(args),
      },
      {
        ...BILI_LIVE_REMINDER_TOOL_DECLS[2],
        handler: (args) => this.unfollowTool(args),
      },
    ];
  }

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const t = text(language);
    const count = this.uids().length;
    const state: WorldLamp['state'] = this.stopped
      ? 'offline'
      : this.inFlight
        ? 'loading'
        : count > 0
          ? 'online'
          : 'offline';
    let hint = this.stopped ? t.lampStopped : count === 0 ? t.lampNoUids : t.lampWatching(count, this.intervalSeconds());
    if (!this.stopped && this.lastError) hint = `${hint} ${t.lampLastError(this.lastError)}`;
    else if (!this.stopped && this.lastPollAt) hint = `${hint} ${t.lampLastCheck(this.lastPollAt)}`;

    return {
      label: t.moduleLabel,
      lamps: [{ label: t.lampLabel, state, hint }],
      config: [biliLiveReminderConfigGroup(language)],
      panels: [
        {
          id: 'subscriptions',
          title: t.panelTitle,
        },
      ],
      invoke: (panel, method, args) => this.invokePanel(panel, method, args),
      promptDocs: [
        {
          key: 'worlds.bili-live-reminder.envPrompt',
          title: t.promptDocTitle,
          description: t.promptDocDescription,
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [
            { name: 'bili_live_reminder.intervalSeconds', description: t.varIntervalDescription },
            { name: 'bili_live_reminder.followedCount', description: t.varFollowedDescription },
            { name: 'bili_live_reminder.includeRoomLink', description: t.varLinkDescription },
            { name: 'bili_live_reminder.notifyOnStart', description: t.varStartupDescription },
          ],
        },
      ],
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.stopped = false;
    this.failures = 0;
    this.lastPollAt = null;
    this.lastError = null;
    this.lastWarnings = [];
    this.snapshots.clear();
    this.baseline.clear();
    this.baselineReady = false;
    this.notifyOnStart = this.cfg.notifyAlreadyLiveOnStart !== false;

    const count = this.uids().length;
    host.log.info(
      count === 0
        ? 'B 站开播提醒已启动:还没有关注主播。'
        : `B 站开播提醒已启动:关注 ${count} 位,每 ${this.intervalSeconds()} 秒检查一次,首次检查在 ${Math.round(INITIAL_POLL_DELAY_MS / 1000)} 秒后。`,
    );
    // 首次检查稍后开始,让进程与主会话先就绪;0ms 在装配期容易让启动汇总丢在会话建立之前。
    this.scheduleNext(INITIAL_POLL_DELAY_MS);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimer();
    this.abort?.abort();
    this.abort = null;
    this.host = null;
  }

  /** 立即检查一次(工具 refresh 与测试用);已有请求在飞时复用它。 */
  async pollNow(): Promise<void> {
    if (this.stopped) return;
    if (this.inFlight) return this.inFlight;
    this.clearTimer();
    const run = this.runPoll();
    this.inFlight = run;
    try {
      await run;
    } finally {
      if (this.inFlight === run) this.inFlight = null;
    }
  }

  private uids(): number[] {
    return parseUids(this.cfg.uids).uids;
  }

  private intervalSeconds(): number {
    const raw = Number(this.cfg.pollIntervalSec);
    if (!Number.isFinite(raw)) return DEFAULT_POLL_SECONDS;
    return Math.min(MAX_POLL_SECONDS, Math.max(MIN_POLL_SECONDS, Math.round(raw)));
  }

  private includeRoomLink(): boolean {
    return this.cfg.includeRoomLink !== false;
  }

  /** `本场开播于 10-30 00:06`;接口没给开播时间时返回空串。 */
  private formatLiveTime(liveTime: number): string {
    if (!Number.isFinite(liveTime) || liveTime <= 0) return '';
    try {
      return new Intl.DateTimeFormat('zh-CN', {
        timeZone: this.timezone,
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(new Date(liveTime * 1000));
    } catch {
      return '';
    }
  }

  private async runPoll(): Promise<void> {
    if (this.stopped) return;
    const uids = this.uids();
    if (uids.length === 0) {
      this.baseline.clear();
      this.snapshots.clear();
      // 不要在这里把基线标记为已建立:启动时 UID 还没加载/还没填时,第一次非空检查
      // 仍应被当作启动检查,否则启动汇总永远不会发。
      this.lastError = null;
      this.lastWarnings = [];
      this.failures = 0;
      this.scheduleNext(this.intervalSeconds() * 1000);
      return;
    }

    this.abort = new AbortController();
    let result;
    try {
      result = await fetchLiveSnapshots(uids, { fetch: this.fetchImpl, signal: this.signalForRequest() });
    } finally {
      this.abort = null;
    }
    if (this.stopped) return;

    if (result.error) {
      this.failures += 1;
      this.lastError = result.error;
      this.lastWarnings = [];
      const delay = this.retryDelay(result.errorStatus, result.errorCode);
      this.host?.log.warn(`B 站开播检查失败,${Math.round(delay / 1000)} 秒后重试:${result.error}`);
      this.scheduleNext(delay);
      return;
    }

    this.failures = 0;
    this.lastError = null;
    this.lastWarnings = result.warnings;
    this.lastPollAt = nowIso(this.timezone);
    if (result.warnings.length) {
      this.host?.log.warn(`B 站开播检查有 UID 没查到:${result.warnings.join(';')}`);
    }
    try {
      await this.applySnapshots(uids, result.snapshots);
    } catch (error) {
      this.host?.log.warn(`B 站开播提醒投递事件失败:${error instanceof Error ? error.message : String(error)}`);
    }
    this.scheduleNext(this.intervalSeconds() * 1000);
  }

  private async applySnapshots(uids: number[], incoming: Map<number, LiveSnapshot>): Promise<void> {
    const followed = new Set(uids);
    for (const uid of [...this.snapshots.keys()]) {
      if (!followed.has(uid)) this.snapshots.delete(uid);
    }
    for (const [uid, snapshot] of incoming) this.snapshots.set(uid, snapshot);

    if (!this.baselineReady) {
      for (const uid of uids) {
        const snapshot = incoming.get(uid);
        if (snapshot) this.baseline.set(uid, snapshot);
      }
      const desired = this.cfg.notifyAlreadyLiveOnStart !== false;
      if (desired) {
        const live = uids
          .map((uid) => incoming.get(uid))
          .filter((snapshot): snapshot is LiveSnapshot => snapshot !== undefined && snapshot.live);
        // 推成功后才算建立基线;启动期投递失败时,下一次检查会重试这条汇总。
        if (live.length > 0) await this.pushSummary(live, 'startup');
      }
      this.notifyOnStart = desired;
      this.baselineReady = true;
      return;
    }

    const started: LiveSnapshot[] = [];
    for (const uid of uids) {
      const snapshot = incoming.get(uid);
      if (!snapshot) continue;
      const previous = this.baseline.get(uid);
      const newSession =
        snapshot.live &&
        (previous === undefined ||
          !previous.live ||
          (snapshot.liveTime > 0 && previous.liveTime > 0 && snapshot.liveTime !== previous.liveTime));
      this.baseline.set(uid, snapshot);
      if (newSession) started.push(snapshot);
    }
    for (const uid of [...this.baseline.keys()]) {
      if (!followed.has(uid)) this.baseline.delete(uid);
    }
    for (const snapshot of started) await this.pushLive(snapshot);

    // 启动提醒是热开关:运行中从关到开时,下一次检查补一条「当前在播汇总」。
    const desired = this.cfg.notifyAlreadyLiveOnStart !== false;
    if (desired && !this.notifyOnStart) {
      const live = uids
        .map((uid) => incoming.get(uid))
        .filter((snapshot): snapshot is LiveSnapshot => snapshot !== undefined && snapshot.live);
      if (live.length > 0) await this.pushSummary(live, 'current');
    }
    this.notifyOnStart = desired;
  }

  private async pushLive(snapshot: LiveSnapshot): Promise<void> {
    const host = this.host;
    if (!host) return;
    const area = snapshot.area ? `（${snapshot.area}）` : '';
    const startedAt = this.formatLiveTime(snapshot.liveTime);
    const session = startedAt ? `（本场开播于 ${startedAt}）` : '';
    const title = snapshot.title ? `:「${snapshot.title}」` : '';
    const link = this.includeRoomLink() ? ` ${roomLink(snapshot.roomId)}` : '';
    const linkNote = this.includeRoomLink() ? '' : '（播报链接已关闭,本条不附链接）';
    host.log.info(
      `B 站开播提醒:${snapshot.uname}(UID ${snapshot.uid}) 开播${startedAt ? `,本场 ${startedAt}` : ''}。`,
    );
    await host.pushEvent(
      {
        type: `${WORLD_ID}.live`,
        ts: nowIso(this.timezone),
        source: WORLD_ID,
        senderKey: `${WORLD_ID}:${snapshot.uid}`,
        text: `B 站主播「${snapshot.uname}」开播了${session}${title}${area}${link}${linkNote}`,
        meta: {
          uid: snapshot.uid,
          roomId: snapshot.roomId,
          uname: snapshot.uname,
          title: snapshot.title,
          area: snapshot.area,
          liveTime: snapshot.liveTime,
        },
      },
      { trigger: 'flush' },
    );
  }

  private async pushSummary(live: LiveSnapshot[], kind: SummaryKind): Promise<void> {
    const host = this.host;
    if (!host) return;
    host.log.info(`B 站开播提醒:现在有 ${live.length} 位关注的主播在播。`);
    const checkedAt = this.formatLiveTime(Math.floor(Date.now() / 1000));
    const linkNote = this.includeRoomLink() ? '' : '（播报链接已关闭）';
    const lines = live.map(
      (snapshot) =>
        `- ${snapshot.uname}:${snapshot.title ? `「${snapshot.title}」` : '正在直播'}${snapshot.area ? `（${snapshot.area}）` : ''}${
          this.formatLiveTime(snapshot.liveTime) ? `（本场开播于 ${this.formatLiveTime(snapshot.liveTime)}）` : ''
        }${this.includeRoomLink() ? ` ${roomLink(snapshot.roomId)}` : ''}`,
    );
    await host.pushEvent(
      {
        type: `${WORLD_ID}.${kind}`,
        ts: nowIso(this.timezone),
        source: WORLD_ID,
        senderKey: `${WORLD_ID}:${kind}`,
        text: `现在有 ${live.length} 位关注的主播在播${checkedAt ? `（${checkedAt}）` : ''}:${linkNote}\n${lines.join('\n')}`,
        meta: { kind, count: live.length, uids: live.map((snapshot) => snapshot.uid) },
      },
      { trigger: 'flush' },
    );
  }

  /**
   * 关注管理面板的数据面:列表、按 UID 新增、按 UID 删除。
   * 只改 `worlds.bili-live-reminder.uids`,不写文件;解析昵称与房间号仍走公开接口。
   */
  private async invokePanel(panel: string, method: string, args: unknown[]): Promise<unknown> {
    if (panel !== 'subscriptions') throw new Error(`unknown panel: ${panel}`);
    const first = Array.isArray(args) ? args[0] : undefined;
    switch (method) {
      case 'list': {
        await this.ensureProfiles(this.uids());
        return this.subscriptionView();
      }
      case 'add': {
        const uid = toUid(first);
        if (uid === null) throw new Error('UID 必须是 1 到 4294967295 之间的整数。');
        const current = this.uids();
        if (current.includes(uid)) throw new Error(`已经订阅 UID ${uid} 了。`);
        if (current.length >= MAX_FOLLOWED_UIDS) {
          throw new Error(`最多订阅 ${MAX_FOLLOWED_UIDS} 位,请先删除一个。`);
        }
        const lookup = await this.lookup(uid);
        if (lookup.kind === 'not-found') {
          throw new Error(`没有找到 UID ${uid} 的直播间,请确认 UID 是否正确。`);
        }
        if (lookup.kind === 'error') {
          throw new Error(`查询 UID ${uid} 失败:${lookup.message}`);
        }
        this.persistConfig({ uids: serializeUids([...current, uid]) });
        this.baseline.set(uid, lookup.snapshot);
        this.snapshots.set(uid, lookup.snapshot);
        // 从 0 个关注开始手动加第一个:这是用户刚做的操作,不该再补一条「启动汇总」。
        if (current.length === 0) this.baselineReady = true;
        return this.subscriptionView();
      }
      case 'remove': {
        const uid = toUid(first);
        if (uid === null) throw new Error('UID 必须是 1 到 4294967295 之间的整数。');
        const current = this.uids();
        if (current.includes(uid)) {
          this.persistConfig({ uids: serializeUids(current.filter((item) => item !== uid)) });
          this.baseline.delete(uid);
          this.snapshots.delete(uid);
        }
        return this.subscriptionView();
      }
      default:
        throw new Error(`unknown method: ${method}`);
    }
  }

  /** 面板打开时把还没有快照的 UID 一次查回来,失败就保持"未知",不影响轮询。 */
  private async ensureProfiles(uids: number[]): Promise<void> {
    const missing = uids.filter((uid) => !this.snapshots.has(uid));
    if (missing.length === 0) return;
    const result = await fetchLiveSnapshots(missing, {
      fetch: this.fetchImpl,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (result.error) return;
    for (const [uid, snapshot] of result.snapshots) this.snapshots.set(uid, snapshot);
  }

  private subscriptionView(): SubscriptionView {
    const notifyOnStart = this.notifyOnStart;
    const notifyOnStartPending = notifyOnStart !== (this.cfg.notifyAlreadyLiveOnStart !== false);
    return {
      items: this.uids().map((uid) => {
        const snapshot = this.snapshots.get(uid);
        return {
          uid,
          uname: snapshot?.uname ?? `UID ${uid}`,
          roomId: snapshot?.roomId ?? null,
          live: snapshot ? snapshot.live : null,
          title: snapshot?.title ?? '',
          area: snapshot?.area ?? '',
        };
      }),
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
      lastWarnings: this.lastWarnings,
      pollIntervalSec: this.intervalSeconds(),
      notifyOnStart,
      notifyOnStartPending,
    };
  }

  private async statusTool(args: Record<string, unknown>): Promise<string | ToolOutcome> {
    if (args.refresh === true) await this.pollNow();

    const uids = this.uids();
    if (uids.length === 0) {
      return '还没有关注任何 B 站主播。可以在本 World 的设置里填 UID,或让我用 bili_live_follow 关注。';
    }

    let filter: number | null = null;
    if (args.uid !== undefined && args.uid !== null) {
      filter = toUid(args.uid);
      if (filter === null) return { text: 'UID 必须是 1 到 4294967295 之间的整数。', failed: true };
      if (!uids.includes(filter)) {
        return `没有关注 UID ${filter}。当前关注:${uids.join(', ')}。`;
      }
    }

    const lines: string[] = [
      `关注 ${uids.length} 位 B 站主播,每 ${this.intervalSeconds()} 秒检查一次;${
        this.lastPollAt ? `上次检查 ${this.lastPollAt}` : '还没有成功检查过'
      }。`,
    ];
    if (this.lastError) lines.push(`上次检查失败:${this.lastError}`);
    if (this.lastWarnings.length) lines.push(`部分 UID 没查到:${this.lastWarnings.join(';')}`);
    if (!this.includeRoomLink()) lines.push('播报链接已关闭,本次不附链接。');

    for (const uid of filter === null ? uids : [filter]) {
      const snapshot = this.snapshots.get(uid);
      if (!snapshot) {
        lines.push(`- UID ${uid}:还没有查到状态`);
        continue;
      }
      const link = this.includeRoomLink() ? ` ${roomLink(snapshot.roomId)}` : '';
      if (!snapshot.live) {
        lines.push(`- ${snapshot.uname}(UID ${uid}):未开播${link}`);
        continue;
      }
      const title = snapshot.title ? `,「${snapshot.title}」` : '';
      const area = snapshot.area ? `,${snapshot.area}` : '';
      lines.push(`- ${snapshot.uname}(UID ${uid}):直播中${title}${area}${link}`);
    }
    return lines.join('\n');
  }

  private async followTool(args: Record<string, unknown>): Promise<string | ToolOutcome> {
    const uid = toUid(args.uid);
    if (uid === null) return { text: 'UID 必须是 1 到 4294967295 之间的整数。', failed: true };

    const current = this.uids();
    if (current.includes(uid)) {
      const snapshot = this.snapshots.get(uid);
      const state = snapshot ? `,${snapshot.live ? '正在直播' : '未开播'}` : '';
      return `已经关注 UID ${uid}${state}。`;
    }
    if (current.length >= MAX_FOLLOWED_UIDS) {
      return { text: `关注列表最多 ${MAX_FOLLOWED_UIDS} 位,请先取消关注一个。`, failed: true };
    }

    const lookup = await this.lookup(uid);
    if (lookup.kind === 'not-found') {
      return {
        text: `没有找到 UID ${uid} 的直播间,请确认 UID 是否正确(B 站个人空间地址里的那串数字)。`,
        failed: true,
      };
    }

    this.persistConfig({ uids: serializeUids([...current, uid]) });

    if (lookup.kind === 'found') {
      this.baseline.set(uid, lookup.snapshot);
      this.snapshots.set(uid, lookup.snapshot);
      // 从 0 个关注开始手动加第一个:这是用户刚做的操作,不该再补一条「启动汇总」。
      if (current.length === 0) this.baselineReady = true;
      const linkNote = this.includeRoomLink() ? '' : ',播报链接已关闭';
      const liveTitle = lookup.snapshot.title ? `「${lookup.snapshot.title}」` : '直播中';
      const status = lookup.snapshot.live
        ? `当前正在直播:${liveTitle}${
            this.includeRoomLink() ? ` ${roomLink(lookup.snapshot.roomId)}` : ''
          }${linkNote}`
        : '当前未开播,开播时会提醒你。';
      return `已关注 UID ${uid}(${lookup.snapshot.uname})。${status}`;
    }

    return `已关注 UID ${uid},但暂时查不到直播状态(${lookup.message})。后台检查会继续。`;
  }

  private async unfollowTool(args: Record<string, unknown>): Promise<string | ToolOutcome> {
    const uid = toUid(args.uid);
    if (uid === null) return { text: 'UID 必须是 1 到 4294967295 之间的整数。', failed: true };

    const current = this.uids();
    if (!current.includes(uid)) {
      return `本来就没有关注 UID ${uid}。当前关注 ${current.length} 位。`;
    }
    const snapshot = this.snapshots.get(uid);
    this.persistConfig({ uids: serializeUids(current.filter((item) => item !== uid)) });
    this.baseline.delete(uid);
    this.snapshots.delete(uid);
    return `已取消关注 UID ${uid}${snapshot ? `(${snapshot.uname})` : ''}。现在关注 ${current.length - 1} 位。`;
  }

  private async lookup(uid: number): Promise<LookupResult> {
    const result = await fetchLiveSnapshots([uid], {
      fetch: this.fetchImpl,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (result.error) return { kind: 'error', message: result.error };
    const snapshot = result.snapshots.get(uid);
    if (snapshot) return { kind: 'found', snapshot };
    if (result.warnings.length > 0) return { kind: 'error', message: result.warnings[0] ?? '查询失败' };
    return { kind: 'not-found' };
  }

  private signalForRequest(): AbortSignal {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    return this.abort ? AbortSignal.any([this.abort.signal, timeout]) : timeout;
  }

  private retryDelay(status?: number, code?: number): number {
    const base = Math.max(this.intervalSeconds() * 1000, 30_000);
    const exponential = Math.min(base * 2 ** Math.min(this.failures, 5), 30 * 60_000);
    return status === 412 || code === -352 ? Math.max(exponential, 10 * 60_000) : exponential;
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pollNow().catch((error) => {
        this.host?.log.warn(`B 站开播提醒检查异常:${error instanceof Error ? error.message : String(error)}`);
      });
    }, Math.max(0, delayMs));
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}
