import { describe, expect, it } from 'vitest';
import {
  anchorInfoUrl,
  cleanText,
  fetchLiveSnapshots,
  parseUids,
  roomInfoUrl,
  statusUrl,
  type FetchLike,
} from '../src/bilibili.ts';

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

describe('parseUids', () => {
  it('接受逗号、中文逗号、分号与空白,并去重', () => {
    expect(parseUids('2, 7777，2  3;4')).toEqual({
      uids: [2, 7777, 3, 4],
      invalid: [],
      overflow: 0,
    });
  });

  it('接受 16 位新 UID', () => {
    expect(parseUids('3537115310721781')).toEqual({
      uids: [3537115310721781],
      invalid: [],
      overflow: 0,
    });
  });

  it('拒绝非数字、0 与超出范围的 UID', () => {
    const result = parseUids('abc 0 9007199254740992 12x');
    expect(result.uids).toEqual([]);
    expect(result.invalid).toEqual(['abc', '0', '9007199254740992', '12x']);
  });

  it('超过 50 位时只收前 50 位并报告溢出', () => {
    const raw = Array.from({ length: 51 }, (_, index) => String(index + 1)).join(',');
    const result = parseUids(raw);
    expect(result.uids).toHaveLength(50);
    expect(result.uids[49]).toBe(50);
    expect(result.overflow).toBe(1);
  });

  it('非字符串输入不抛错', () => {
    expect(parseUids(null)).toEqual({ uids: [], invalid: [], overflow: 0 });
    expect(parseUids(123).uids).toEqual([123]);
  });
});

describe('URL 与文本', () => {
  it('批量接口把每个 UID 写成 uids[] 参数', () => {
    const url = new URL(statusUrl([2, 7777]));
    expect(url.searchParams.getAll('uids[]')).toEqual(['2', '7777']);
    expect(statusUrl([2])).toContain('uids%5B%5D=2');
    expect(new URL(statusUrl([3537115310721781])).searchParams.get('uids[]')).toBe('3537115310721781');
  });

  it('兜底接口用 mid 参数', () => {
    const url = new URL(roomInfoUrl(2));
    expect(url.origin + url.pathname).toBe('https://api.live.bilibili.com/room/v1/Room/getRoomInfoOld');
    expect(url.searchParams.get('mid')).toBe('2');
  });

  it('主播信息接口用 roomid 参数', () => {
    const url = new URL(anchorInfoUrl(1024));
    expect(url.origin + url.pathname).toBe('https://api.live.bilibili.com/live_user/v1/UserInfo/get_anchor_in_room');
    expect(url.searchParams.get('roomid')).toBe('1024');
  });

  it('第三方文字压成一行并截断', () => {
    expect(cleanText('a\n  b\tc', 10)).toBe('a b c');
    expect(cleanText('abcdef', 4)).toBe('abc…');
    expect(cleanText(undefined, 10)).toBe('');
  });
});

describe('fetchLiveSnapshots', () => {
  it('批量查询并解析开播状态、分区与开播时间', async () => {
    let init: RequestInit | undefined;
    const fetchImpl: FetchLike = async (_input, options) => {
      init = options;
      return jsonResponse({
        code: 0,
        data: {
          '2': statusEntry(2, { live_status: 1, live_time: 1_700_000_000, title: ' 今晚\n打游戏 ' }),
          '7777': statusEntry(7777, { room_id: 7_047_858, uname: '钉子' }),
        },
      });
    };

    const result = await fetchLiveSnapshots([2, 7777], { fetch: fetchImpl });
    expect(result.error).toBeNull();
    expect(result.missing).toEqual([]);
    expect(result.snapshots.get(2)).toMatchObject({
      uid: 2,
      roomId: 1024,
      uname: '主播2',
      title: '今晚 打游戏',
      area: '网游 · 吃鸡行动',
      live: true,
      liveTime: 1_700_000_000,
    });
    expect(result.snapshots.get(7777)?.live).toBe(false);

    const headers = init?.headers as Record<string, string>;
    expect(headers.Referer).toBe('https://live.bilibili.com/');
    expect(typeof headers['User-Agent']).toBe('string');
    expect(JSON.stringify(headers)).not.toContain('Cookie');
  });

  it('批量接口漏掉某个 UID 时,用 getRoomInfoOld 与主播信息兜底', async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('get_status_info_by_uids')) return jsonResponse({ code: 0, data: {} });
      if (url.includes('get_anchor_in_room')) {
        return jsonResponse({ code: 0, data: { info: { uname: '碧诗' } } });
      }
      return jsonResponse({ code: 0, data: { roomid: 1024, liveStatus: 1, title: '兜底标题' } });
    };

    const result = await fetchLiveSnapshots([2], { fetch: fetchImpl });
    expect(result.error).toBeNull();
    expect(result.warnings).toEqual([]);
    expect(result.snapshots.get(2)).toMatchObject({
      roomId: 1024,
      uname: '碧诗',
      title: '兜底标题',
      live: true,
    });
    expect(calls).toHaveLength(3);
    expect(calls[1]).toContain('getRoomInfoOld');
    expect(calls[2]).toContain('get_anchor_in_room');
  });

  it('主播信息也失败时,昵称保留 UID 兜底', async () => {
    const fetchImpl: FetchLike = async (input) => {
      const url = String(input);
      if (url.includes('get_status_info_by_uids')) return jsonResponse({ code: 0, data: {} });
      if (url.includes('get_anchor_in_room')) return new Response('nope', { status: 500 });
      return jsonResponse({ code: 0, data: { roomid: 1024, liveStatus: 1, title: '兜底标题' } });
    };
    const result = await fetchLiveSnapshots([2], { fetch: fetchImpl });
    expect(result.error).toBeNull();
    expect(result.snapshots.get(2)?.uname).toBe('UID 2');
  });

  it('兜底也查不到时列入 missing,不算整批失败', async () => {
    const fetchImpl: FetchLike = async (input) => {
      if (String(input).includes('get_status_info_by_uids')) return jsonResponse({ code: 0, data: {} });
      return jsonResponse({ code: 0, data: null });
    };
    const result = await fetchLiveSnapshots([2], { fetch: fetchImpl });
    expect(result.error).toBeNull();
    expect(result.missing).toEqual([2]);
    expect(result.snapshots.size).toBe(0);
  });

  it('HTTP 412 作为整批失败返回,带状态码', async () => {
    const fetchImpl: FetchLike = async () => new Response('blocked', { status: 412 });
    const result = await fetchLiveSnapshots([2], { fetch: fetchImpl });
    expect(result.error).toContain('HTTP 412');
    expect(result.errorStatus).toBe(412);
    expect(result.snapshots.size).toBe(0);
  });

  it('接口 code 非 0 时带 code 返回', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ code: -352, message: '风控校验失败' });
    const result = await fetchLiveSnapshots([2], { fetch: fetchImpl });
    expect(result.error).toContain('-352');
    expect(result.error).toContain('风控校验失败');
    expect(result.errorCode).toBe(-352);
  });

  it('网络错误转成可读错误,不抛异常', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error('network down');
    };
    const result = await fetchLiveSnapshots([2], { fetch: fetchImpl });
    expect(result.error).toContain('network down');
    expect(result.snapshots.size).toBe(0);
  });

  it('空列表不发请求', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return jsonResponse({ code: 0, data: {} });
    };
    const result = await fetchLiveSnapshots([], { fetch: fetchImpl });
    expect(calls).toBe(0);
    expect(result).toEqual({ snapshots: new Map(), missing: [], error: null, warnings: [] });
  });
});
