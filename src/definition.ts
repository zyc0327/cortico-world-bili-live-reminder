import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { BILI_LIVE_REMINDER_DEFAULTS, type BiliLiveReminderConfigSection } from './config.ts';
import { BILI_LIVE_REMINDER_TOOL_DECLS, BiliLiveReminderWorld, WORLD_ID } from './world.ts';

export const BILI_LIVE_REMINDER: WorldDefinition<BiliLiveReminderConfigSection> = {
  id: WORLD_ID,
  label: 'B 站开播提醒',
  // `ctx.cfg` 是 `worlds.bili-live-reminder` 的活引用:UID 列表与检查间隔热改即生效。
  defaults: () => ({ ...BILI_LIVE_REMINDER_DEFAULTS }),
  create: (ctx) =>
    new BiliLiveReminderWorld({
      cfg: ctx.cfg,
      timezone: ctx.timezone,
      persist: (patch) => ctx.persist(patch),
    }),
  // 自描述:可能出现的全部工具与会推出的全部事件,不进提示词。
  describe: {
    tools: describeTools(BILI_LIVE_REMINDER_TOOL_DECLS, {
      bili_live_status: {
        zh: '查询关注的主播现在谁在播:标题、分区、直播间链接、上次检查时间与最近错误;可要求立即查一次。',
        en: 'Reads which followed streamers are live right now, with title, area, room link, last check time and any recent error; can refresh immediately.',
      },
      bili_live_follow: {
        zh: '按 UID 关注一位 B 站主播,开播时提醒;回执带主播名与当前是否在播。',
        en: 'Follows a Bilibili streamer by UID so the bot reminds the user when they go live; the receipt carries the name and current status.',
      },
      bili_live_unfollow: {
        zh: '按 UID 取消关注,不再提醒这位主播。',
        en: 'Stops following a Bilibili streamer by UID, so the reminders end.',
      },
    }),
    events: [
      {
        type: `${WORLD_ID}.live`,
        description: {
          zh: '关注的主播从「未开播」变成「直播中」,或同一场直播换了一次开播时间;带主播名、标题、分区与直播间链接。',
          en: 'A followed streamer went from offline to live, or started a new session; carries the name, title, area and room link.',
        },
        trigger: 'flush',
      },
      {
        type: `${WORLD_ID}.startup`,
        description: {
          zh: '启动后的第一次检查发现已有主播在播,把所有在播的主播汇总成一条;只有在配置里打开启动提醒时才会推出。',
          en: 'The first check after startup found streamers already live; one summary of all of them, only when the startup option is on.',
        },
        trigger: 'flush',
      },
      {
        type: `${WORLD_ID}.current`,
        description: {
          zh: '运行中把「启动时已在播也提醒」打开时,下一次检查汇总当前在播的主播;不是刚刚开播。',
          en: 'The startup option was turned on while running; the next check summarizes who is live now. Not a new go-live.',
        },
        trigger: 'flush',
      },
    ],
  },
};
