/**
 * B 站公开直播状态接口的只读客户端。
 *
 * 只做匿名 GET:不携带 cookie、SESSDATA 或任何密钥,也不读写本机文件。
 * 两个接口都是 B 站网页端在用的公开接口,不是官方开放平台,字段与风控策略可能变化。
 */
import { MAX_FOLLOWED_UIDS } from './config.ts';

export const STATUS_ENDPOINT = 'https://api.live.bilibili.com/room/v1/Room/get_status_info_by_uids';
export const ROOM_INFO_ENDPOINT = 'https://api.live.bilibili.com/room/v1/Room/getRoomInfoOld';
export const ANCHOR_INFO_ENDPOINT = 'https://api.live.bilibili.com/live_user/v1/UserInfo/get_anchor_in_room';

/** 浏览器 UA 与 Referer:公开接口在没有它们时更容易回 412。 */
export const REQUEST_HEADERS: Record<string, string> = {
  Accept: 'application/json, text/plain, */*',
  Referer: 'https://live.bilibili.com/',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
};

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface LiveSnapshot {
  uid: number;
  roomId: number;
  /** 主播昵称;批量接口缺失时回落为 `UID <uid>`。 */
  uname: string;
  title: string;
  /** 分区,形如「网游 · 吃鸡行动」;查不到时为空串。 */
  area: string;
  live: boolean;
  /** 本场开播时间(Unix 秒);接口没给时为 0,用于识别同一场直播。 */
  liveTime: number;
}

export interface FetchSnapshotsOptions {
  fetch?: FetchLike;
  signal?: AbortSignal;
}

export interface FetchSnapshotsResult {
  snapshots: Map<number, LiveSnapshot>;
  /** 请求过、但没有拿到状态的 UID。 */
  missing: number[];
  /** 整批请求失败;此时不产生任何事件。 */
  error: string | null;
  errorStatus?: number;
  errorCode?: number;
  /** 批量成功、个别 UID 的兜底查询失败;只影响这些 UID。 */
  warnings: string[];
}

export class BilibiliApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'BilibiliApiError';
  }
}

export interface UidParseResult {
  uids: number[];
  invalid: string[];
  /** 超过上限、没有收下的 UID 数量。 */
  overflow: number;
}

/** 解析配置里的 UID 字符串:逗号、中文逗号、分号与空白都算分隔符。 */
export function parseUids(raw: unknown): UidParseResult {
  const source = typeof raw === 'string' ? raw : typeof raw === 'number' ? String(raw) : '';
  const uids: number[] = [];
  const invalid: string[] = [];
  let overflow = 0;
  for (const token of source.split(/[\s,，;；]+/)) {
    if (token === '') continue;
    if (!/^\d{1,10}$/.test(token)) {
      invalid.push(token);
      continue;
    }
    const uid = Number(token);
    if (!Number.isSafeInteger(uid) || uid < 1 || uid > 4_294_967_295) {
      invalid.push(token);
      continue;
    }
    if (uids.includes(uid)) continue;
    if (uids.length >= MAX_FOLLOWED_UIDS) {
      overflow += 1;
      continue;
    }
    uids.push(uid);
  }
  return { uids, invalid, overflow };
}

export function serializeUids(uids: readonly number[]): string {
  return uids.join(', ');
}

export function roomLink(roomId: number): string {
  return `https://live.bilibili.com/${roomId}`;
}

/** 把第三方文字压成一行并截断,避免标题里的换行改变事件结构。 */
export function cleanText(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') return '';
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, Math.max(0, maxChars - 1))}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return null;
}

function toPositiveInt(value: unknown): number | null {
  const parsed = toInt(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

export function statusUrl(uids: readonly number[]): string {
  const url = new URL(STATUS_ENDPOINT);
  for (const uid of uids) url.searchParams.append('uids[]', String(uid));
  return url.toString();
}

export function roomInfoUrl(uid: number): string {
  const url = new URL(ROOM_INFO_ENDPOINT);
  url.searchParams.set('mid', String(uid));
  return url.toString();
}

export function anchorInfoUrl(roomId: number): string {
  const url = new URL(ANCHOR_INFO_ENDPOINT);
  url.searchParams.set('roomid', String(roomId));
  return url.toString();
}

async function requestJson(url: string, options: FetchSnapshotsOptions): Promise<unknown> {
  const doFetch = options.fetch ?? globalThis.fetch;
  if (typeof doFetch !== 'function') throw new BilibiliApiError('当前运行环境没有 fetch');
  let response: Response;
  try {
    response = await doFetch(url, {
      method: 'GET',
      headers: REQUEST_HEADERS,
      signal: options.signal,
      redirect: 'follow',
    });
  } catch (error) {
    if (isAbortError(error)) throw new BilibiliApiError('请求 B 站接口超时或被取消');
    throw new BilibiliApiError(`请求 B 站接口失败:${errorMessage(error)}`);
  }
  if (!response.ok) {
    throw new BilibiliApiError(`B 站接口返回 HTTP ${response.status}`, response.status);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new BilibiliApiError(`B 站接口返回的不是 JSON(HTTP ${response.status})`, response.status);
  }
  if (!isRecord(body)) throw new BilibiliApiError('B 站接口返回的结构不认识', response.status);
  const code = toInt(body.code);
  if (code !== null && code !== 0) {
    const detail = cleanText(body.message ?? body.msg, 120) || '未知错误';
    throw new BilibiliApiError(`B 站接口返回 code ${code}:${detail}`, response.status, code);
  }
  return body;
}

function snapshotFromStatusEntry(uid: number, entry: unknown): LiveSnapshot | null {
  if (!isRecord(entry)) return null;
  const roomId = toPositiveInt(entry.room_id);
  if (roomId === null) return null;
  const areaName = cleanText(entry.area_v2_name, 32) || cleanText(entry.area_name, 32);
  const parent = cleanText(entry.area_v2_parent_name, 24);
  const area = parent && areaName && parent !== areaName ? `${parent} · ${areaName}` : areaName;
  return {
    uid,
    roomId,
    uname: cleanText(entry.uname, 40) || `UID ${uid}`,
    title: cleanText(entry.title, 80),
    area,
    live: toInt(entry.live_status) === 1,
    liveTime: Math.max(0, toInt(entry.live_time) ?? 0),
  };
}

function snapshotFromRoomInfo(uid: number, entry: unknown): LiveSnapshot | null {
  if (!isRecord(entry)) return null;
  const roomId = toPositiveInt(entry.roomid);
  if (roomId === null) return null;
  return {
    uid,
    roomId,
    uname: `UID ${uid}`,
    title: cleanText(entry.title, 80),
    area: '',
    live: toInt(entry.liveStatus) === 1,
    liveTime: 0,
  };
}

async function fetchBatch(
  uids: readonly number[],
  options: FetchSnapshotsOptions,
): Promise<{ snapshots: Map<number, LiveSnapshot>; missing: number[] }> {
  const body = await requestJson(statusUrl(uids), options);
  const data = isRecord(body) ? body.data : null;
  if (!isRecord(data)) throw new BilibiliApiError('B 站接口没有返回 data');
  const snapshots = new Map<number, LiveSnapshot>();
  const missing: number[] = [];
  for (const uid of uids) {
    const snapshot = snapshotFromStatusEntry(uid, data[String(uid)]);
    if (snapshot) snapshots.set(uid, snapshot);
    else missing.push(uid);
  }
  return { snapshots, missing };
}

async function fetchOne(uid: number, options: FetchSnapshotsOptions): Promise<LiveSnapshot | null> {
  const body = await requestJson(roomInfoUrl(uid), options);
  const data = isRecord(body) ? body.data : null;
  const snapshot = snapshotFromRoomInfo(uid, data);
  if (!snapshot) return null;
  // 兜底接口不带昵称,再问一次直播间主播信息;失败就保留 `UID <uid>`。
  const uname = await fetchAnchorName(snapshot.roomId, options);
  return uname ? { ...snapshot, uname } : snapshot;
}

async function fetchAnchorName(roomId: number, options: FetchSnapshotsOptions): Promise<string | null> {
  try {
    const body = await requestJson(anchorInfoUrl(roomId), options);
    const data = isRecord(body) ? body.data : null;
    const info = isRecord(data) ? data.info : null;
    return cleanText(isRecord(info) ? info.uname : '', 40) || null;
  } catch {
    return null;
  }
}

/**
 * 查一批 UID 的直播状态。先走批量接口;批量成功但某个 UID 没回来时,
 * 再单独问一次 `getRoomInfoOld`。整批失败才算 error。
 */
export async function fetchLiveSnapshots(
  uids: readonly number[],
  options: FetchSnapshotsOptions = {},
): Promise<FetchSnapshotsResult> {
  const unique = [...new Set(uids)].slice(0, MAX_FOLLOWED_UIDS);
  if (unique.length === 0) return { snapshots: new Map(), missing: [], error: null, warnings: [] };

  let batch: { snapshots: Map<number, LiveSnapshot>; missing: number[] };
  try {
    batch = await fetchBatch(unique, options);
  } catch (error) {
    return {
      snapshots: new Map(),
      missing: unique,
      error: errorMessage(error),
      errorStatus: error instanceof BilibiliApiError ? error.status : undefined,
      errorCode: error instanceof BilibiliApiError ? error.code : undefined,
      warnings: [],
    };
  }

  const snapshots = new Map(batch.snapshots);
  const warnings: string[] = [];
  for (const uid of batch.missing) {
    try {
      const snapshot = await fetchOne(uid, options);
      if (snapshot) snapshots.set(uid, snapshot);
    } catch (error) {
      warnings.push(`UID ${uid}:${errorMessage(error)}`);
    }
  }

  return {
    snapshots,
    missing: unique.filter((uid) => !snapshots.has(uid)),
    error: null,
    warnings,
  };
}
