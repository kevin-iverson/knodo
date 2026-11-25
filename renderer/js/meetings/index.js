'use strict';
/**
 * 会议纪要 · 渲染层唯一入口：mount(pref) / unmount() / applyPref(pref)。
 *
 * 与 worklog / journal 插件同构：
 *  - 侧栏「会议纪要」入口常驻，关闭时点进来是引导页（ui.js#renderMeetingsOff）；
 *  - 关闭态本文件与 meetings.js 都不会被 import —— 没有视图 DOM、监听和按钮；
 *  - 卸载时若用户正停在会议页，就地重绘成引导页，不踢回任务列表。
 */
import { EXT } from '../ext.js';
import { t as tr } from '../i18n.js';
import { navigateTo, renderSidebar, toast } from '../ui.js';
import { renderMeetings, setMeetingsHandlers, autoProcessMeeting as runAutoProcess } from '../meetings.js';

let mounted = false;
let prefCache = null;

function toggleRecordingButtons(on) {
  for (const id of ['btn-record-audio', 'btn-record-screen']) {
    const btn = document.getElementById(id);
    if (btn) btn.hidden = !on;
  }
}

export async function mount(pref) {
  if (mounted) return;
  mounted = true;
  prefCache = pref || { enabled: true };

  setMeetingsHandlers({ toast, refresh: () => { renderSidebar().catch(() => {}); } });
  toggleRecordingButtons(true);

  EXT.views.meetings = {
    title: tr('会议纪要'),
    desc: tr('录制 / 导入会议音频 → 语音转写 → AI 纪要 → 待办入库'),
    long: tr('录音或导入音视频，自动转写并由 AI 整理成纪要；勾选项可一键写入任务列表。关闭插件后历史记录仍保留。'),
    render: (root) => renderMeetings(root),
  };

  const nav = document.querySelector('.nav-item[data-view="meetings"]');
  if (nav && nav.classList.contains('active')) {
    await navigateTo('meetings');
  }
}

export function unmount() {
  if (!mounted) return;
  mounted = false;
  const onMeetingView = !!(document.querySelector('.nav-item[data-view="meetings"]')
    && document.querySelector('.nav-item[data-view="meetings"]').classList.contains('active'));

  delete EXT.views.meetings;
  toggleRecordingButtons(false);

  if (onMeetingView) navigateTo('meetings').catch((e) => console.warn('[meeting] 卸载重绘失败', e));
}

/** 设置里改了偏好：不重挂模块，只同步缓存 */
export function applyPref(pref) {
  if (!pref) return;
  prefCache = pref;
}

/** 录音完成后自动处理；只在插件挂载时才有业务 IPC */
export async function autoProcessMeeting(m) {
  if (!mounted) return false;
  await runAutoProcess(m);
  return true;
}

/** 供验收脚本读取当前挂载状态与偏好 */
export function debugState() {
  return { mounted, pref: prefCache };
}
