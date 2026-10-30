import type { ConfigGroup } from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';
import { text } from './strings.ts';

/** 关注列表上限:再多就分成两次查,避免一条 URL 过长。 */
export const MAX_FOLLOWED_UIDS = 50;
export const MIN_POLL_SECONDS = 30;
export const MAX_POLL_SECONDS = 600;
export const DEFAULT_POLL_SECONDS = 60;
export const MIN_REPEAT_SECONDS = 30;
export const MAX_REPEAT_SECONDS = 3600;
export const DEFAULT_REPEAT_SECONDS = 300;
export const DEFAULT_REPEAT_COUNT = 2;
export const MAX_REPEAT_COUNT = 10;

/** config.json 的 worlds.bili-live-reminder 段。默认禁用,由 bot 声明或部署配置启用。 */
export interface BiliLiveReminderConfigSection {
  enabled: boolean;
  /** 关注的主播 UID,逗号、中文逗号或空白分隔;每次轮询现读。 */
  uids: string;
  /** 轮询间隔,秒;每次轮询现读。 */
  pollIntervalSec: number;
  /** 启动后的第一次检查,对已经在播的主播发一条汇总;默认开,下次启动生效。 */
  notifyAlreadyLiveOnStart: boolean;
  /** Coo 的播报与工具回执里是否附带直播间链接;每次输出现读。 */
  includeRoomLink: boolean;
  /** 首次提醒之后最多再提醒几次;-1 无限,0 不重复,1–10 指定次数。 */
  repeatCount: number;
  /** 未确认时两次重复提醒之间的间隔,秒。 */
  repeatIntervalSec: number;
}

export const BILI_LIVE_REMINDER_DEFAULTS: BiliLiveReminderConfigSection = {
  enabled: false,
  uids: '',
  pollIntervalSec: DEFAULT_POLL_SECONDS,
  notifyAlreadyLiveOnStart: true,
  includeRoomLink: true,
  repeatCount: DEFAULT_REPEAT_COUNT,
  repeatIntervalSec: DEFAULT_REPEAT_SECONDS,
};

/** World 配置的 JSON Schema 声明;每个路径都必须落在 worlds.bili-live-reminder. 段内。 */
export function biliLiveReminderConfigGroup(language: Language): ConfigGroup {
  const t = text(language);
  return {
    id: 'world:bili-live-reminder',
    owner: 'world:bili-live-reminder',
    schema: {
      type: 'object',
      title: t.configTitle,
      description: t.configDescription,
      properties: {
        'worlds.bili-live-reminder.pollIntervalSec': {
          type: 'integer',
          title: t.intervalTitle,
          description: t.intervalDescription,
          minimum: MIN_POLL_SECONDS,
          maximum: MAX_POLL_SECONDS,
          multipleOf: 10,
          'x-hot': true,
          'x-suffix': t.suffixSeconds,
        },
        'worlds.bili-live-reminder.notifyAlreadyLiveOnStart': {
          type: 'boolean',
          title: t.notifyOnStartTitle,
          description: t.notifyOnStartDescription,
          'x-hot': true,
        },
        'worlds.bili-live-reminder.includeRoomLink': {
          type: 'boolean',
          title: t.includeRoomLinkTitle,
          description: t.includeRoomLinkDescription,
          'x-hot': true,
        },
        'worlds.bili-live-reminder.repeatCount': {
          type: 'integer',
          title: t.repeatCountTitle,
          description: t.repeatCountDescription,
          minimum: -1,
          maximum: MAX_REPEAT_COUNT,
          'x-hot': true,
        },
        'worlds.bili-live-reminder.repeatIntervalSec': {
          type: 'integer',
          title: t.repeatIntervalTitle,
          description: t.repeatIntervalDescription,
          minimum: MIN_REPEAT_SECONDS,
          maximum: MAX_REPEAT_SECONDS,
          multipleOf: 10,
          'x-hot': true,
          'x-suffix': t.suffixSeconds,
        },
      },
    },
  };
}
