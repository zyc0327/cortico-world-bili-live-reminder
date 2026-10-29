// src/webui/client.ts
var zh = {
  title: "\u5173\u6CE8\u7BA1\u7406",
  description: "\u8F93\u5165\u4E00\u4F4D\u4E3B\u64AD\u7684 UID \u540E\u70B9\u300C\u65B0\u589E\u300D\u3002\u5217\u8868\u663E\u793A\u6635\u79F0\u3001\u76F4\u64AD\u95F4\u53F7\u4E0E\u5F53\u524D\u72B6\u6001;\u70B9\u300C\u5220\u9664\u300D\u53D6\u6D88\u63D0\u9192\u3002",
  uidLabel: "\u4E3B\u64AD UID",
  placeholder: "\u4F8B\u5982 672328094",
  add: "\u65B0\u589E",
  remove: "\u5220\u9664",
  columns: ["\u4E3B\u64AD", "\u76F4\u64AD\u95F4", "\u72B6\u6001", "\u64CD\u4F5C"],
  live: "\u76F4\u64AD\u4E2D",
  offline: "\u672A\u5F00\u64AD",
  unknown: "\u672A\u77E5",
  unknownRoom: "\u672A\u627E\u5230\u76F4\u64AD\u95F4",
  room: "\u623F\u95F4",
  summary: (count, seconds) => `\u5DF2\u8BA2\u9605 ${count} \u4F4D \xB7 \u6BCF ${seconds} \u79D2\u68C0\u67E5\u4E00\u6B21`,
  startupOff: "\u542F\u52A8\u63D0\u9192\u5DF2\u5173(\u5728\u300C\u914D\u7F6E\u300D\u91CC\u6253\u5F00)",
  startupPending: "\u542F\u52A8\u63D0\u9192\u5DF2\u5F00,\u4E0B\u6B21\u68C0\u67E5\u751F\u6548",
  lastCheck: (at) => `\u4E0A\u6B21\u68C0\u67E5 ${at}`,
  lastError: (message) => `\u4E0A\u6B21\u68C0\u67E5\u5931\u8D25:${message}`,
  lastWarnings: (message) => `\u90E8\u5206 UID \u6CA1\u67E5\u5230:${message}`,
  empty: "\u8FD8\u6CA1\u6709\u8BA2\u9605\u3002\u8F93\u5165 UID \u540E\u70B9\u65B0\u589E\u3002",
  loading: "\u52A0\u8F7D\u4E2D\u2026",
  loadFailed: "\u5217\u8868\u52A0\u8F7D\u5931\u8D25,\u8BF7\u91CD\u8BD5\u3002",
  needUid: "\u8BF7\u5148\u8F93\u5165 UID\u3002",
  invalid: "UID \u5FC5\u987B\u662F 1 \u5230 4294967295 \u4E4B\u95F4\u7684\u6574\u6570\u3002",
  added: (name) => `\u5DF2\u65B0\u589E\u300C${name}\u300D\u3002`,
  removed: (name) => `\u5DF2\u5220\u9664\u300C${name}\u300D\u3002`,
  confirmTitle: "\u53D6\u6D88\u5173\u6CE8",
  confirmBody: (name) => `\u4E0D\u518D\u63D0\u9192\u300C${name}\u300D\u7684\u5F00\u64AD?`,
  failed: "\u64CD\u4F5C\u5931\u8D25"
};
var en = {
  title: "Follows",
  description: "Enter a streamer UID and press Add. The list shows the nickname, room ID and current status; Delete stops the reminders.",
  uidLabel: "Streamer UID",
  placeholder: "e.g. 672328094",
  add: "Add",
  remove: "Delete",
  columns: ["Streamer", "Room", "Status", "Actions"],
  live: "Live",
  offline: "Offline",
  unknown: "Unknown",
  unknownRoom: "No room found",
  room: "Room",
  summary: (count, seconds) => `${count} followed \xB7 checking every ${seconds} s`,
  startupOff: "Startup summary is off (turn it on in Settings)",
  startupPending: "Startup summary is on; applies on the next check",
  lastCheck: (at) => `Last check ${at}`,
  lastError: (message) => `Last check failed: ${message}`,
  lastWarnings: (message) => `Some UIDs were not resolved: ${message}`,
  empty: "No follows yet. Enter a UID and press Add.",
  loading: "Loading\u2026",
  loadFailed: "Could not load the list. Try again.",
  needUid: "Enter a UID first.",
  invalid: "UID must be an integer between 1 and 4294967295.",
  added: (name) => `Added "${name}".`,
  removed: (name) => `Removed "${name}".`,
  confirmTitle: "Unfollow",
  confirmBody: (name) => `Stop reminding you when "${name}" goes live?`,
  failed: "Failed"
};
var text = (language) => language === "zh" || language === "zh-Hant" ? zh : en;
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}
var subscriptionsPanel = {
  mount(ctx) {
    const t = text(ctx.language);
    const sheet = ctx.ui.sheet({ title: t.title, desc: t.description });
    ctx.root.appendChild(sheet.el);
    const body = sheet.body;
    const input = ctx.ui.input({ type: "text", placeholder: t.placeholder });
    input.style.width = "100%";
    const addBtn = ctx.ui.button(t.add, {
      variant: "primary",
      onClick: () => {
        void add();
      }
    });
    const controls = ctx.ui.rowbar();
    controls.style.alignItems = "flex-end";
    const field = ctx.ui.field(t.uidLabel, input);
    field.style.flex = "0 1 320px";
    field.style.minWidth = "220px";
    field.style.margin = "0";
    controls.append(field, addBtn);
    body.appendChild(controls);
    const message = ctx.ui.msgline();
    body.appendChild(message);
    const summary = ctx.ui.msgline();
    body.appendChild(summary);
    const table = ctx.ui.table({ head: t.columns });
    body.appendChild(table.el);
    let view = null;
    const show = (body2, bad = false) => {
      message.textContent = body2;
      message.classList.toggle("bad", bad);
    };
    const render = () => {
      if (!view) {
        table.clear(t.loading);
        return;
      }
      table.clear(view.items.length === 0 ? t.empty : void 0);
      const parts = [t.summary(view.items.length, view.pollIntervalSec)];
      if (!view.notifyOnStart) {
        parts.push(view.notifyOnStartPending ? t.startupPending : t.startupOff);
      }
      if (view.lastPollAt) parts.push(t.lastCheck(view.lastPollAt));
      summary.textContent = parts.join(" \xB7 ");
      summary.classList.toggle("bad", Boolean(view.lastError));
      if (view.lastError) show(t.lastError(view.lastError), true);
      else if (view.lastWarnings.length > 0) show(t.lastWarnings(view.lastWarnings.join("; ")), true);
      for (const item of view.items) {
        const nameCell = document.createElement("div");
        const name = document.createElement("div");
        name.textContent = item.uname;
        if (item.title) name.title = item.title;
        const uid = document.createElement("div");
        uid.className = "mono";
        uid.textContent = `UID ${item.uid}`;
        nameCell.append(name, uid);
        const roomCell = document.createElement("div");
        if (item.roomId === null) {
          roomCell.textContent = t.unknownRoom;
        } else {
          const label = document.createElement("span");
          label.textContent = `${t.room} `;
          const link = document.createElement("a");
          link.href = `https://live.bilibili.com/${item.roomId}`;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.className = "mono";
          link.textContent = String(item.roomId);
          roomCell.append(label, link);
          if (item.live && item.title) {
            const title = document.createElement("div");
            title.className = "tdesc";
            title.textContent = item.title;
            roomCell.appendChild(title);
          }
        }
        const state = ctx.ui.pill(
          item.live === null ? t.unknown : item.live ? t.live : t.offline,
          item.live === null ? "plain" : item.live ? "on" : "off"
        );
        const removeBtn = ctx.ui.button(t.remove, {
          variant: "danger",
          size: "sm",
          onClick: () => {
            void remove(item);
          }
        });
        table.addRow([nameCell, roomCell, state, removeBtn]);
      }
    };
    const load = async () => {
      const lock = ctx.ui.disable(input, addBtn);
      try {
        view = await ctx.invoke("list");
        render();
      } catch (error) {
        show(`${t.failed}: ${errorText(error)}`, true);
        table.clear(t.loadFailed);
      } finally {
        lock.dispose();
      }
    };
    const add = async () => {
      const raw = input.value.trim();
      if (!raw) {
        show(t.needUid, true);
        return;
      }
      if (!/^\d{1,10}$/.test(raw)) {
        show(t.invalid, true);
        return;
      }
      const uid = Number(raw);
      if (!Number.isSafeInteger(uid) || uid < 1 || uid > 4294967295) {
        show(t.invalid, true);
        return;
      }
      const lock = ctx.ui.disable(input, addBtn);
      try {
        view = await ctx.invoke("add", [uid]);
        input.value = "";
        const name = view.items.find((item) => item.uid === uid)?.uname ?? String(uid);
        render();
        show(t.added(name));
      } catch (error) {
        show(`${t.failed}: ${errorText(error)}`, true);
      } finally {
        lock.dispose();
      }
    };
    const remove = async (item) => {
      const confirmed = await ctx.ui.confirm({
        title: t.confirmTitle,
        body: t.confirmBody(item.uname),
        danger: true
      });
      if (!confirmed) return;
      const lock = ctx.ui.disable(input, addBtn);
      try {
        view = await ctx.invoke("remove", [item.uid]);
        render();
        show(t.removed(item.uname));
      } catch (error) {
        show(`${t.failed}: ${errorText(error)}`, true);
      } finally {
        lock.dispose();
      }
    };
    input.addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        void add();
      },
      { signal: ctx.signal }
    );
    void load();
  }
};
var bundle = {
  panels: { subscriptions: subscriptionsPanel }
};
var client_default = bundle;
export {
  client_default as default
};
