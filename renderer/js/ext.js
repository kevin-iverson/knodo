'use strict';
/**
 * 极轻量扩展注册表（方案 §五「ui.js 的三个扩展点」）。
 *
 * 为什么做成全局对象而不是让 ui.js import 插件：ui.js 是 3500 行的巨石，
 * 插件又要在关闭时「完全不存在」。这里只放空数组，关闭态三处调用都是空循环，
 * 没有 import、没有 DOM、没有监听。
 *
 * 注册方（renderer/js/worklog/index.js）：
 *   EXT.taskRowExtra.push(fn)    → 任务列表行渲染完成后追加行内计时 / 禅模式按钮
 *   EXT.views.worklog = {...}    → 工时视图（title / desc / render）
 *
 * detailSection 保留为通用能力（当前没有插件使用）：详情抽屉拼完 HTML 后插入自定义区块。
 */
export const EXT = window.KnodoExt || (window.KnodoExt = {
  taskRowExtra: [],
  detailSection: [],
  viewPanel: [],
  views: {},
});

export function ext(name, ctx) {
  const list = EXT[name] || [];
  for (const fn of list) {
    try { fn(ctx); } catch (e) { console.warn('[ext]', name, e); }
  }
}

/** 视图路由：命中则返回插件注册的 { title, desc, render } */
export function getExtView(view) {
  return EXT.views[view] || null;
}

/** 当前有没有插件挂上任何入口（用来决定顶栏要不要保留） */
export function hasExtViews() {
  return Object.keys(EXT.views).length > 0;
}
