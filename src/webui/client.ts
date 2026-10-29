/**
 * 关注管理面板(浏览器端)。
 *
 * 只通过 ctx.invoke 与宿主数据面通信;不读 config、不直连 /api、不碰 document.body。
 * 服务端负责解析昵称与直播间号,浏览器只负责输入、列表与删除。
 */
import type {
  WebUiClientBundle,
  WebUiPanel,
  WebUiPanelContext,
} from 'cortico/web/shared/client-panel.ts';

/** B 站新 UID 是 16 位;与 src/bilibili.ts 的 MAX_UID 保持一致。 */
const MAX_UID = 9_007_199_254_740_991;

interface SubscriptionItem {
  uid: number;
  uname: string;
  roomId: number | null;
  live: boolean | null;
  title: string;
  area: string;
}

interface SubscriptionView {
  items: SubscriptionItem[];
  lastPollAt: string | null;
  lastError: string | null;
  lastWarnings: string[];
  pollIntervalSec: number;
  notifyOnStart: boolean;
  notifyOnStartPending: boolean;
}

interface PanelText {
  title: string;
  description: string;
  uidLabel: string;
  placeholder: string;
  add: string;
  remove: string;
  columns: readonly string[];
  live: string;
  offline: string;
  unknown: string;
  unknownRoom: string;
  room: string;
  summary: (count: number, seconds: number) => string;
  startupOff: string;
  startupPending: string;
  lastCheck: (at: string) => string;
  lastError: (message: string) => string;
  lastWarnings: (message: string) => string;
  empty: string;
  loading: string;
  loadFailed: string;
  needUid: string;
  invalid: string;
  added: (name: string) => string;
  removed: (name: string) => string;
  confirmTitle: string;
  confirmBody: (name: string) => string;
  failed: string;
}

const zh: PanelText = {
  title: '关注管理',
  description: '输入一位主播的 UID 后点「新增」。列表显示昵称、直播间号与当前状态;点「删除」取消提醒。',
  uidLabel: '主播 UID',
  placeholder: '例如 672328094',
  add: '新增',
  remove: '删除',
  columns: ['主播', '直播间', '状态', '操作'],
  live: '直播中',
  offline: '未开播',
  unknown: '未知',
  unknownRoom: '未找到直播间',
  room: '房间',
  summary: (count, seconds) => `已订阅 ${count} 位 · 每 ${seconds} 秒检查一次`,
  startupOff: '启动提醒已关(在「配置」里打开)',
  startupPending: '启动提醒已开,下次检查生效',
  lastCheck: (at) => `上次检查 ${at}`,
  lastError: (message) => `上次检查失败:${message}`,
  lastWarnings: (message) => `部分 UID 没查到:${message}`,
  empty: '还没有订阅。输入 UID 后点新增。',
  loading: '加载中…',
  loadFailed: '列表加载失败,请重试。',
  needUid: '请先输入 UID。',
  invalid: `UID 必须是 1 到 ${MAX_UID} 之间的整数。`,
  added: (name) => `已新增「${name}」。`,
  removed: (name) => `已删除「${name}」。`,
  confirmTitle: '取消关注',
  confirmBody: (name) => `不再提醒「${name}」的开播?`,
  failed: '操作失败',
};

const en: PanelText = {
  title: 'Follows',
  description: 'Enter a streamer UID and press Add. The list shows the nickname, room ID and current status; Delete stops the reminders.',
  uidLabel: 'Streamer UID',
  placeholder: 'e.g. 672328094',
  add: 'Add',
  remove: 'Delete',
  columns: ['Streamer', 'Room', 'Status', 'Actions'],
  live: 'Live',
  offline: 'Offline',
  unknown: 'Unknown',
  unknownRoom: 'No room found',
  room: 'Room',
  summary: (count, seconds) => `${count} followed · checking every ${seconds} s`,
  startupOff: 'Startup summary is off (turn it on in Settings)',
  startupPending: 'Startup summary is on; applies on the next check',
  lastCheck: (at) => `Last check ${at}`,
  lastError: (message) => `Last check failed: ${message}`,
  lastWarnings: (message) => `Some UIDs were not resolved: ${message}`,
  empty: 'No follows yet. Enter a UID and press Add.',
  loading: 'Loading…',
  loadFailed: 'Could not load the list. Try again.',
  needUid: 'Enter a UID first.',
  invalid: `UID must be an integer between 1 and ${MAX_UID}.`,
  added: (name) => `Added "${name}".`,
  removed: (name) => `Removed "${name}".`,
  confirmTitle: 'Unfollow',
  confirmBody: (name) => `Stop reminding you when "${name}" goes live?`,
  failed: 'Failed',
};

const text = (language: WebUiPanelContext['language']): PanelText =>
  language === 'zh' || language === 'zh-Hant' ? zh : en;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const subscriptionsPanel: WebUiPanel = {
  mount(ctx) {
    const t = text(ctx.language);
    // 整块内容放进同一张卡:标题、描述、输入行、列表共用同一个左边界。
    const sheet = ctx.ui.sheet({ title: t.title, desc: t.description });
    ctx.root.appendChild(sheet.el);
    const body = sheet.body;

    const input = ctx.ui.input({ type: 'text', placeholder: t.placeholder });
    input.style.width = '100%';
    const addBtn = ctx.ui.button(t.add, {
      variant: 'primary',
      onClick: () => {
        void add();
      },
    });
    // 不用 actions():它带 actionbar 的 flex-end 和 24px 上边距,会把输入框推到右边。
    const controls = ctx.ui.rowbar();
    controls.style.alignItems = 'flex-end';
    const field = ctx.ui.field(t.uidLabel, input);
    field.style.flex = '0 1 320px';
    field.style.minWidth = '220px';
    field.style.margin = '0';
    controls.append(field, addBtn);
    body.appendChild(controls);

    const message = ctx.ui.msgline();
    body.appendChild(message);
    const summary = ctx.ui.msgline();
    body.appendChild(summary);

    const table = ctx.ui.table({ head: t.columns });
    body.appendChild(table.el);

    let view: SubscriptionView | null = null;

    const show = (body: string, bad = false): void => {
      message.textContent = body;
      message.classList.toggle('bad', bad);
    };

    const render = (): void => {
      if (!view) {
        table.clear(t.loading);
        return;
      }
      table.clear(view.items.length === 0 ? t.empty : undefined);

      const parts = [t.summary(view.items.length, view.pollIntervalSec)];
      if (!view.notifyOnStart) {
        parts.push(view.notifyOnStartPending ? t.startupPending : t.startupOff);
      }
      if (view.lastPollAt) parts.push(t.lastCheck(view.lastPollAt));
      summary.textContent = parts.join(' · ');
      summary.classList.toggle('bad', Boolean(view.lastError));
      if (view.lastError) show(t.lastError(view.lastError), true);
      else if (view.lastWarnings.length > 0) show(t.lastWarnings(view.lastWarnings.join('; ')), true);

      for (const item of view.items) {
        const nameCell = document.createElement('div');
        const name = document.createElement('div');
        name.textContent = item.uname;
        if (item.title) name.title = item.title;
        const uid = document.createElement('div');
        uid.className = 'mono';
        uid.textContent = `UID ${item.uid}`;
        nameCell.append(name, uid);

        const roomCell = document.createElement('div');
        if (item.roomId === null) {
          roomCell.textContent = t.unknownRoom;
        } else {
          const label = document.createElement('span');
          label.textContent = `${t.room} `;
          const link = document.createElement('a');
          link.href = `https://live.bilibili.com/${item.roomId}`;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.className = 'mono';
          link.textContent = String(item.roomId);
          roomCell.append(label, link);
          if (item.live && item.title) {
            const title = document.createElement('div');
            title.className = 'tdesc';
            title.textContent = item.title;
            roomCell.appendChild(title);
          }
        }

        const state = ctx.ui.pill(
          item.live === null ? t.unknown : item.live ? t.live : t.offline,
          item.live === null ? 'plain' : item.live ? 'on' : 'off',
        );
        const removeBtn = ctx.ui.button(t.remove, {
          variant: 'danger',
          size: 'sm',
          onClick: () => {
            void remove(item);
          },
        });
        table.addRow([nameCell, roomCell, state, removeBtn]);
      }
    };

    const load = async (): Promise<void> => {
      const lock = ctx.ui.disable(input, addBtn);
      try {
        view = await ctx.invoke<SubscriptionView>('list');
        render();
      } catch (error) {
        show(`${t.failed}: ${errorText(error)}`, true);
        table.clear(t.loadFailed);
      } finally {
        lock.dispose();
      }
    };

    const add = async (): Promise<void> => {
      const raw = input.value.trim();
      if (!raw) {
        show(t.needUid, true);
        return;
      }
      if (!/^\d{1,16}$/.test(raw)) {
        show(t.invalid, true);
        return;
      }
      const uid = Number(raw);
      if (!Number.isSafeInteger(uid) || uid < 1 || uid > MAX_UID) {
        show(t.invalid, true);
        return;
      }

      const lock = ctx.ui.disable(input, addBtn);
      try {
        view = await ctx.invoke<SubscriptionView>('add', [uid]);
        input.value = '';
        const name = view.items.find((item) => item.uid === uid)?.uname ?? String(uid);
        render();
        show(t.added(name));
      } catch (error) {
        show(`${t.failed}: ${errorText(error)}`, true);
      } finally {
        lock.dispose();
      }
    };

    const remove = async (item: SubscriptionItem): Promise<void> => {
      const confirmed = await ctx.ui.confirm({
        title: t.confirmTitle,
        body: t.confirmBody(item.uname),
        danger: true,
      });
      if (!confirmed) return;

      const lock = ctx.ui.disable(input, addBtn);
      try {
        view = await ctx.invoke<SubscriptionView>('remove', [item.uid]);
        render();
        show(t.removed(item.uname));
      } catch (error) {
        show(`${t.failed}: ${errorText(error)}`, true);
      } finally {
        lock.dispose();
      }
    };

    input.addEventListener(
      'keydown',
      (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        void add();
      },
      { signal: ctx.signal },
    );

    void load();
  },
};

const bundle: WebUiClientBundle = {
  panels: { subscriptions: subscriptionsPanel },
};

export default bundle;
