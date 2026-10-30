import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolCallContext, ToolDef } from 'cortico/core/types.ts';
import { renderTemplate, templateVarNames } from 'cortico/core/template.ts';
import { dryMountWorld, fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { BILI_LIVE_REMINDER } from '../src/definition.ts';
import {
  BILI_LIVE_REMINDER_DEFAULTS,
  type BiliLiveReminderConfigSection,
} from '../src/config.ts';
import {
  BILI_LIVE_REMINDER_TOOL_DECLS,
  BiliLiveReminderWorld,
  type SubscriptionView,
} from '../src/world.ts';
import type { FetchLike } from '../src/bilibili.ts';
import { FakeHost } from './helpers/fake-host.ts';

const call = {} as ToolCallContext;
let scratchDir: string;
const running: BiliLiveReminderWorld[] = [];

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'bili-live-reminder-'));
});

afterEach(async () => {
  for (const world of running.splice(0)) await world.stop();
  rmSync(scratchDir, { recursive: true, force: true });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function statusEntry(uid: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    room_id: uid === 2 ? 1024 : 7_047_858,
    uid,
    live_status: 0,
    live_time: 0,
    uname: `主播${uid}`,
    title: `标题${uid}`,
    area_v2_name: '吃鸡行动',
    area_v2_parent_name: '网游',
    ...overrides,
  };
}

function entriesFetcher(entries: () => Record<string, unknown>): FetchLike {
  return async (input) => {
    if (String(input).includes('get_status_info_by_uids')) {
      return jsonResponse({ code: 0, data: entries() });
    }
    return jsonResponse({ code: 0, data: null });
  };
}

interface MadeWorld {
  world: BiliLiveReminderWorld;
  cfg: BiliLiveReminderConfigSection;
}

function makeWorld(
  overrides: Partial<BiliLiveReminderConfigSection> = {},
  fetchImpl?: FetchLike,
  now?: () => number,
): MadeWorld {
  const cfg: BiliLiveReminderConfigSection = { ...BILI_LIVE_REMINDER_DEFAULTS, ...overrides };
  const world = new BiliLiveReminderWorld({
    cfg,
    timezone: 'Asia/Shanghai',
    persist: (patch) => {
      Object.assign(cfg, patch);
    },
    fetch: fetchImpl,
    timeoutMs: 1_000,
    now,
  });
  return { world, cfg };
}

async function startWorld(world: BiliLiveReminderWorld, host = new FakeHost()): Promise<FakeHost> {
  running.push(world);
  await world.start(host);
  await world.pollNow();
  return host;
}

function tool(world: BiliLiveReminderWorld, name: string): ToolDef {
  const found = world.tools().find((item) => item.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

describe('B 站开播提醒 World', () => {
  it('干装载不报失败:装载器会接受它', async () => {
    const report = await dryMountWorld(BILI_LIVE_REMINDER, { scratchDir, hasWebUiClient: true });
    expect(report.failures).toEqual([]);
  });

  it('工具名、describe.json 与定义一致', async () => {
    const { world } = makeWorld();
    expect(world.tools().map((item) => item.name).sort()).toEqual(
      BILI_LIVE_REMINDER_TOOL_DECLS.map((item) => item.name).sort(),
    );

    const doc = JSON.parse(readFileSync(new URL('../describe.json', import.meta.url), 'utf8')) as {
      tools: unknown;
      events: unknown;
      prompts: Array<{ key: string; title: string; role: string; content: string }>;
    };
    expect(doc.tools).toEqual(BILI_LIVE_REMINDER.describe?.tools);
    expect(doc.events).toEqual(BILI_LIVE_REMINDER.describe?.events);

    const definition = BILI_LIVE_REMINDER.create(
      fakeWorldContext(BILI_LIVE_REMINDER, { scratchDir, packageDir: join(scratchDir, 'pkg') }),
    );
    const ui = definition.webUi!('zh');
    expect(ui.panels?.map((panel) => panel.id)).toEqual(['subscriptions']);
    expect(ui.panels?.[0]?.title).toBe('关注管理');
    expect(typeof ui.invoke).toBe('function');
    const prompt = ui.promptDocs?.find((item) => item.role === 'envPrompt');
    expect(prompt).toBeDefined();
    expect(doc.prompts).toEqual([
      {
        key: prompt!.key,
        title: prompt!.title,
        role: prompt!.role,
        content: readFileSync(prompt!.path, 'utf8'),
      },
    ]);

    // 模板占位符只认 [\w.],包 id 里的连字符不能出现在变量名里。
    const vars = await definition.envPromptVars();
    expect(vars).not.toBeNull();
    expect(vars).toMatchObject({
      'bili_live_reminder.includeRoomLink': '开',
      'bili_live_reminder.notifyOnStart': '开',
      'bili_live_reminder.repeatCount': '2',
      'bili_live_reminder.repeatIntervalSec': '300',
    });
    const content = readFileSync(prompt!.path, 'utf8');
    for (const name of templateVarNames(content)) {
      expect(Object.prototype.hasOwnProperty.call(vars, name)).toBe(true);
    }
    expect(renderTemplate(content, vars!)).not.toContain('{{');
  });

  it('第一次检查只建基线,不为已在播的主播补事件', async () => {
    const { world } = makeWorld(
      { uids: '2', notifyAlreadyLiveOnStart: false },
      entriesFetcher(() => ({ '2': statusEntry(2, { live_status: 1, live_time: 100 }) })),
    );
    const host = await startWorld(world);
    expect(host.events).toEqual([]);
  });

  it('未开播变直播中时推一条 flush 事件,同一场不重复', async () => {
    let live = false;
    let liveTime = 0;
    const { world } = makeWorld(
      { uids: '2' },
      entriesFetcher(() => ({
        '2': statusEntry(2, { live_status: live ? 1 : 0, live_time: liveTime }),
      })),
    );
    const host = await startWorld(world);
    expect(host.events).toEqual([]);

    live = true;
    liveTime = 100;
    await world.pollNow();
    expect(host.events.map((event) => event.type)).toEqual(['bili-live-reminder.live']);
    expect(host.pushOpts[0]).toEqual({ trigger: 'flush' });
    expect(host.events[0].source).toBe('bili-live-reminder');
    expect(host.events[0].text).toContain('主播2');
    expect(host.events[0].text).toContain('标题2');
    expect(host.events[0].text).toContain('「标题2」');
    expect(host.events[0].text).toContain('本场开播于');
    expect(host.events[0].text).toContain('https://live.bilibili.com/1024');
    expect(host.events[0].meta).toMatchObject({ uid: 2, roomId: 1024, liveTime: 100 });

    await world.pollNow();
    expect(host.events).toHaveLength(1);
  });

  it('同一场直播换了开播时间时当作新一场', async () => {
    let liveTime = 100;
    const { world } = makeWorld(
      { uids: '2', notifyAlreadyLiveOnStart: false },
      entriesFetcher(() => ({ '2': statusEntry(2, { live_status: 1, live_time: liveTime }) })),
    );
    const host = await startWorld(world);
    // 第一次检查把 live_time=100 记为基线;换到 200 说明主播重新开了一场。
    liveTime = 200;
    await world.pollNow();
    expect(host.events.map((event) => event.type)).toEqual(['bili-live-reminder.live']);

    liveTime = 300;
    await world.pollNow();
    expect(host.events).toHaveLength(2);
  });

  it('打开启动提醒时,第一次检查汇总已在播的主播', async () => {
    const { world } = makeWorld(
      { uids: '2, 7777', notifyAlreadyLiveOnStart: true },
      entriesFetcher(() => ({
        '2': statusEntry(2, { live_status: 1, live_time: 100 }),
        '7777': statusEntry(7777, { room_id: 7_047_858, live_status: 1, live_time: 200 }),
      })),
    );
    const host = await startWorld(world);
    expect(host.events.map((event) => event.type)).toEqual(['bili-live-reminder.startup']);
    expect(host.pushOpts[0]).toEqual({ trigger: 'flush' });
    expect(host.events[0].text).toContain('2 位关注的主播在播');
    expect(host.events[0].text).not.toContain('启动检查');
    expect(host.events[0].text).not.toContain('汇总');
    expect(host.events[0].text).toContain('主播2');
    expect(host.events[0].text).toContain('「标题2」');
    expect(host.events[0].text).toContain('主播7777');
    expect(host.events[0].text).toContain('本场开播于');
    expect(host.events[0].meta).toMatchObject({ count: 2, uids: [2, 7777] });
  });

  it('启动时没有 UID,后来加上时第一次非空检查仍发启动汇总', async () => {
    const { world, cfg } = makeWorld(
      { uids: '', notifyAlreadyLiveOnStart: true },
      entriesFetcher(() => ({
        '2': statusEntry(2, { live_status: 1, live_time: 100 }),
      })),
    );
    const host = await startWorld(world);
    expect(host.events).toEqual([]);

    cfg.uids = '2';
    await world.pollNow();
    expect(host.events.map((event) => event.type)).toEqual(['bili-live-reminder.startup']);
  });

  it('运行中打开启动提醒,下一次检查发当前在播情况', async () => {
    const { world, cfg } = makeWorld(
      { uids: '2', notifyAlreadyLiveOnStart: false },
      entriesFetcher(() => ({
        '2': statusEntry(2, { live_status: 1, live_time: 100 }),
      })),
    );
    const host = await startWorld(world);
    expect(host.events).toEqual([]);

    cfg.notifyAlreadyLiveOnStart = true;
    await world.pollNow();
    expect(host.events.map((event) => event.type)).toEqual(['bili-live-reminder.current']);
    expect(host.events[0].text).toContain('现在有 1 位关注的主播在播');
    expect(host.events[0].text).not.toContain('当前在播汇总');
    expect(host.events[0].text).not.toContain('启动检查');
  });

  it('重复提醒按配置的次数与间隔发送', async () => {
    let clock = 1_000_000;
    const { world } = makeWorld(
      { uids: '2', notifyAlreadyLiveOnStart: true, repeatCount: 1, repeatIntervalSec: 30 },
      entriesFetcher(() => ({
        '2': statusEntry(2, { live_status: 1, live_time: 100 }),
      })),
      () => clock,
    );
    const host = await startWorld(world);
    expect(host.events.map((event) => event.type)).toEqual(['bili-live-reminder.startup']);

    clock += 30_000;
    await world.pollNow();
    expect(host.events.map((event) => event.type)).toEqual([
      'bili-live-reminder.startup',
      'bili-live-reminder.repeat',
    ]);
    expect(host.events[1].text).toContain('再提醒一次');
    expect(host.events[1].text).toContain('还在播');
    expect(host.events[1].text).toContain('「标题2」');

    clock += 30_000;
    await world.pollNow();
    expect(host.events).toHaveLength(2);
  });

  it('重复提醒次数为 0 时不重复', async () => {
    let clock = 1_000_000;
    const { world } = makeWorld(
      { uids: '2', notifyAlreadyLiveOnStart: true, repeatCount: 0, repeatIntervalSec: 30 },
      entriesFetcher(() => ({
        '2': statusEntry(2, { live_status: 1, live_time: 100 }),
      })),
      () => clock,
    );
    const host = await startWorld(world);
    clock += 60_000;
    await world.pollNow();
    expect(host.events.map((event) => event.type)).toEqual(['bili-live-reminder.startup']);
  });

  it('重复提醒次数为 -1 时持续发送', async () => {
    let clock = 1_000_000;
    const { world } = makeWorld(
      { uids: '2', notifyAlreadyLiveOnStart: true, repeatCount: -1, repeatIntervalSec: 30 },
      entriesFetcher(() => ({
        '2': statusEntry(2, { live_status: 1, live_time: 100 }),
      })),
      () => clock,
    );
    const host = await startWorld(world);
    for (let round = 0; round < 3; round += 1) {
      clock += 30_000;
      await world.pollNow();
    }
    expect(host.events.filter((event) => event.type === 'bili-live-reminder.repeat')).toHaveLength(3);
  });

  it('bili_live_ack 确认后停止重复', async () => {
    let clock = 1_000_000;
    const { world } = makeWorld(
      { uids: '2', notifyAlreadyLiveOnStart: true, repeatCount: -1, repeatIntervalSec: 30 },
      entriesFetcher(() => ({
        '2': statusEntry(2, { live_status: 1, live_time: 100 }),
      })),
      () => clock,
    );
    const host = await startWorld(world);
    clock += 30_000;
    await world.pollNow();
    expect(host.events.filter((event) => event.type === 'bili-live-reminder.repeat')).toHaveLength(1);

    const receipt = await tool(world, 'bili_live_ack').handler({ name: '主播2' }, call);
    expect(String(receipt)).toContain('已确认 1 位');

    clock += 60_000;
    await world.pollNow();
    expect(host.events.filter((event) => event.type === 'bili-live-reminder.repeat')).toHaveLength(1);
  });

  it('bili_live_ack 不带参数确认全部待确认提醒', async () => {
    let clock = 1_000_000;
    const { world } = makeWorld(
      { uids: '2, 7777', notifyAlreadyLiveOnStart: true, repeatCount: -1, repeatIntervalSec: 30 },
      entriesFetcher(() => ({
        '2': statusEntry(2, { live_status: 1, live_time: 100 }),
        '7777': statusEntry(7777, { room_id: 7_047_858, live_status: 1, live_time: 200 }),
      })),
      () => clock,
    );
    const host = await startWorld(world);
    const receipt = await tool(world, 'bili_live_ack').handler({}, call);
    expect(String(receipt)).toContain('已确认 2 位');

    clock += 60_000;
    await world.pollNow();
    expect(host.events.filter((event) => event.type === 'bili-live-reminder.repeat')).toHaveLength(0);
  });

  it('没有待确认提醒时 bili_live_ack 返回提示', async () => {
    const { world } = makeWorld();
    const receipt = await tool(world, 'bili_live_ack').handler({}, call);
    expect(String(receipt)).toContain('没有待确认的提醒');
  });

  it('没有关注时完全不发请求', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return jsonResponse({ code: 0, data: {} });
    };
    const { world } = makeWorld({ uids: '' }, fetchImpl);
    const host = await startWorld(world);
    expect(calls).toBe(0);
    expect(host.events).toEqual([]);
  });

  it('bili_live_follow 写入配置、立即报当前状态,且不重复推事件', async () => {
    const { world, cfg } = makeWorld(
      { uids: '' },
      entriesFetcher(() => ({
        '123': statusEntry(123, {
          room_id: 555,
          live_status: 1,
          live_time: 50,
          uname: '新主播',
          title: '新标题',
        }),
      })),
    );
    const host = await startWorld(world);
    const receipt = await tool(world, 'bili_live_follow').handler({ uid: 123 }, call);
    expect(String(receipt)).toContain('已关注 UID 123');
    expect(String(receipt)).toContain('新主播');
    expect(String(receipt)).toContain('当前正在直播');
    expect(String(receipt)).toContain('「新标题」');
    expect(cfg.uids).toBe('123');

    await world.pollNow();
    expect(host.events).toEqual([]);

    const again = await tool(world, 'bili_live_follow').handler({ uid: 123 }, call);
    expect(String(again)).toContain('已经关注');
  });

  it('支持 16 位新 UID', async () => {
    const uid = 3_537_115_310_721_781;
    const { world, cfg } = makeWorld(
      { uids: '' },
      entriesFetcher(() => ({
        [String(uid)]: statusEntry(uid, { uname: '新主播', title: '十六位', live_status: 0 }),
      })),
    );
    await startWorld(world);

    const receipt = await tool(world, 'bili_live_follow').handler({ uid }, call);
    expect(String(receipt)).toContain(`已关注 UID ${uid}`);
    expect(cfg.uids).toBe(String(uid));

    const view = (await world.webUi('zh').invoke!('subscriptions', 'list', [])) as SubscriptionView;
    expect(view.items[0]).toMatchObject({ uid, uname: '新主播' });
  });

  it('bili_live_follow 拒绝不存在的 UID 和非法 UID', async () => {
    const fetchImpl: FetchLike = async (input) => {
      if (String(input).includes('get_status_info_by_uids')) return jsonResponse({ code: 0, data: {} });
      return jsonResponse({ code: 0, data: null });
    };
    const { world, cfg } = makeWorld({ uids: '' }, fetchImpl);
    await startWorld(world);

    const invalid = await tool(world, 'bili_live_follow').handler({ uid: 0 }, call);
    expect(invalid).toMatchObject({ failed: true });
    expect(cfg.uids).toBe('');

    const missing = await tool(world, 'bili_live_follow').handler({ uid: 999 }, call);
    expect(missing).toMatchObject({ failed: true });
    expect((missing as { text: string }).text).toContain('没有找到 UID 999');
    expect(cfg.uids).toBe('');
  });

  it('bili_live_unfollow 从配置移除并更新状态', async () => {
    const { world, cfg } = makeWorld(
      { uids: '' },
      entriesFetcher(() => ({ '123': statusEntry(123, { live_status: 0 }) })),
    );
    await startWorld(world);
    await tool(world, 'bili_live_follow').handler({ uid: 123 }, call);
    expect(cfg.uids).toBe('123');

    const receipt = await tool(world, 'bili_live_unfollow').handler({ uid: 123 }, call);
    expect(String(receipt)).toContain('已取消关注 UID 123');
    expect(String(receipt)).toContain('现在关注 0 位');
    expect(cfg.uids).toBe('');
  });

  it('bili_live_status 读取缓存并支持按 UID 过滤', async () => {
    const { world } = makeWorld(
      { uids: '2' },
      entriesFetcher(() => ({ '2': statusEntry(2, { live_status: 1, live_time: 100 }) })),
    );
    await startWorld(world);

    const all = await tool(world, 'bili_live_status').handler({}, call);
    expect(String(all)).toContain('关注 1 位');
    expect(String(all)).toContain('主播2');
    expect(String(all)).toContain('直播中');
    expect(String(all)).toContain('「标题2」');
    expect(String(all)).toContain('https://live.bilibili.com/1024');

    const unknown = await tool(world, 'bili_live_status').handler({ uid: 999 }, call);
    expect(String(unknown)).toContain('没有关注 UID 999');
  });

  it('检查失败时只记错误、不推事件;恢复后清掉错误', async () => {
    let fail = true;
    let calls = 0;
    const fetchImpl: FetchLike = async (input) => {
      calls += 1;
      if (fail) throw new Error('network down');
      if (String(input).includes('get_status_info_by_uids')) {
        return jsonResponse({ code: 0, data: { '2': statusEntry(2, { live_status: 0 }) } });
      }
      return jsonResponse({ code: 0, data: null });
    };
    const { world } = makeWorld({ uids: '2' }, fetchImpl);
    const host = await startWorld(world);
    expect(host.events).toEqual([]);

    const failed = await tool(world, 'bili_live_status').handler({}, call);
    expect(String(failed)).toContain('上次检查失败');
    expect(String(failed)).toContain('network down');
    expect(world.webUi('zh').lamps?.[0]?.hint).toContain('失败');

    fail = false;
    await world.pollNow();
    expect(calls).toBeGreaterThanOrEqual(2);
    const recovered = await tool(world, 'bili_live_status').handler({}, call);
    expect(String(recovered)).not.toContain('上次检查失败');
    expect(String(recovered)).toContain('未开播');
  });

  it('关注管理面板:list/add/remove,并返回昵称与直播间号', async () => {
    const { world, cfg } = makeWorld(
      { uids: '' },
      entriesFetcher(() => ({
        '123': statusEntry(123, {
          room_id: 555,
          live_status: 1,
          live_time: 50,
          uname: '新主播',
          title: '新标题',
        }),
      })),
    );
    await startWorld(world);
    const invoke = world.webUi('zh').invoke!;

    const empty = (await invoke('subscriptions', 'list', [])) as SubscriptionView;
    expect(empty.items).toEqual([]);

    const added = (await invoke('subscriptions', 'add', [123])) as SubscriptionView;
    expect(added.items).toHaveLength(1);
    expect(added.items[0]).toMatchObject({
      uid: 123,
      uname: '新主播',
      roomId: 555,
      live: true,
      title: '新标题',
    });
    expect(cfg.uids).toBe('123');

    await expect(invoke('subscriptions', 'add', [123])).rejects.toThrow(/已经订阅/);

    const removed = (await invoke('subscriptions', 'remove', [123])) as SubscriptionView;
    expect(removed.items).toEqual([]);
    expect(cfg.uids).toBe('');
  });

  it('关注管理面板:非法与不存在的 UID 都拒绝', async () => {
    const fetchImpl: FetchLike = async (input) => {
      if (String(input).includes('get_status_info_by_uids')) return jsonResponse({ code: 0, data: {} });
      return jsonResponse({ code: 0, data: null });
    };
    const { world, cfg } = makeWorld({ uids: '' }, fetchImpl);
    await startWorld(world);
    const invoke = world.webUi('zh').invoke!;

    await expect(invoke('subscriptions', 'add', [0])).rejects.toThrow(/UID/);
    await expect(invoke('subscriptions', 'add', [999])).rejects.toThrow(/没有找到/);
    expect(cfg.uids).toBe('');
  });

  it('关注管理面板:list 会为已有 UID 补查昵称和直播间号', async () => {
    const { world } = makeWorld(
      { uids: '2' },
      entriesFetcher(() => ({
        '2': statusEntry(2, { room_id: 1024, live_status: 0, uname: '碧诗', title: '标题2' }),
      })),
    );
    const invoke = world.webUi('zh').invoke!;
    const view = (await invoke('subscriptions', 'list', [])) as SubscriptionView;
    expect(view.items).toEqual([
      {
        uid: 2,
        uname: '碧诗',
        roomId: 1024,
        live: false,
        title: '标题2',
        area: '网游 · 吃鸡行动',
      },
    ]);
  });

  it('默认打开启动提醒并附带直播间链接', () => {
    expect(BILI_LIVE_REMINDER_DEFAULTS.notifyAlreadyLiveOnStart).toBe(true);
    expect(BILI_LIVE_REMINDER_DEFAULTS.includeRoomLink).toBe(true);
    expect(BILI_LIVE_REMINDER_DEFAULTS.repeatCount).toBe(2);
    expect(BILI_LIVE_REMINDER_DEFAULTS.repeatIntervalSec).toBe(300);
  });

  it('启动提醒开关状态反映当前实例,并标出待重启', async () => {
    const { world, cfg } = makeWorld({ uids: '', notifyAlreadyLiveOnStart: false });
    await startWorld(world);
    const invoke = world.webUi('zh').invoke!;

    let view = (await invoke('subscriptions', 'list', [])) as SubscriptionView;
    expect(view.notifyOnStart).toBe(false);
    expect(view.notifyOnStartPending).toBe(false);

    cfg.notifyAlreadyLiveOnStart = true;
    view = (await invoke('subscriptions', 'list', [])) as SubscriptionView;
    expect(view.notifyOnStart).toBe(false);
    expect(view.notifyOnStartPending).toBe(true);
  });

  it('提示词变量反映链接、启动与重复开关', async () => {
    const { world, cfg } = makeWorld();
    let vars = await world.envPromptVars();
    expect(vars).toMatchObject({
      'bili_live_reminder.includeRoomLink': '开',
      'bili_live_reminder.notifyOnStart': '开',
      'bili_live_reminder.repeatCount': '2',
      'bili_live_reminder.repeatIntervalSec': '300',
    });

    cfg.includeRoomLink = false;
    cfg.notifyAlreadyLiveOnStart = false;
    cfg.repeatCount = -1;
    cfg.repeatIntervalSec = 60;
    vars = await world.envPromptVars();
    expect(vars).toMatchObject({
      'bili_live_reminder.includeRoomLink': '关',
      'bili_live_reminder.notifyOnStart': '关',
      'bili_live_reminder.repeatCount': '-1',
      'bili_live_reminder.repeatIntervalSec': '60',
    });
  });

  it('关闭附带直播间链接后,事件与状态查询都不带链接', async () => {
    let live = false;
    const { world } = makeWorld(
      { uids: '2', notifyAlreadyLiveOnStart: false, includeRoomLink: false },
      entriesFetcher(() => ({
        '2': statusEntry(2, { live_status: live ? 1 : 0, live_time: live ? 10 : 0 }),
      })),
    );
    const host = await startWorld(world);
    live = true;
    await world.pollNow();
    expect(host.events).toHaveLength(1);
    expect(host.events[0].text).not.toContain('https://live.bilibili.com');
    expect(host.events[0].text).toContain('播报链接已关闭');

    const status = await tool(world, 'bili_live_status').handler({}, call);
    expect(String(status)).not.toContain('https://live.bilibili.com');
    expect(String(status)).toContain('播报链接已关闭');
  });
});
