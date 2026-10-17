'use strict';
/**
 * 即时持久化（防抖自动保存）。
 *
 * 设计要点：
 * - 输入停止 delay 毫秒后才写库，避免每次按键都产生一次 IPC + 磁盘写入。
 * - 保存前与"最后一次成功写入的基线"比对，内容没变就不写库。
 * - 状态机：idle → pending（等待防抖）→ saving → saved / error，供界面展示。
 * - 失败处理：保留用户输入并给出可重试的错误态；若服务端返回空（任务已被删除等冲突），
 *   按 conflict 处理并交给宿主回滚到权威状态。
 * - 串行化：上一次请求没回来前不发起下一次，避免乱序覆盖。
 */

/** 浅比较：只比对第一层字段，够用于任务表单快照 */
function samePayload(a, b) {
  if (!a || !b) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (k === 'tagIds') {
      const x = (a[k] || []).join(',');
      const y = (b[k] || []).join(',');
      if (x !== y) return false;
    } else if (a[k] !== b[k]) {
      return false;
    }
  }
  return true;
}

/**
 * @param {object} opts
 * @param {number} [opts.delay=700] 防抖延迟（毫秒）
 * @param {(payload:object) => Promise<object|null>} opts.save 真正落库的函数，返回更新后的实体或 null（冲突）
 * @param {() => object|null} opts.read 读取当前表单值的函数；返回 null 表示当前值不合法、暂不保存
 * @param {(state:string, info?:any) => void} [opts.onStatus] idle|pending|saving|saved|error
 * @param {(err:Error) => void} [opts.onError] 写入失败
 * @param {(baseline:object) => void} [opts.onConflict] 任务已不存在等冲突 → 宿主回滚
 * @param {(entity:object) => void} [opts.onSaved] 写入成功
 */
export function createAutoSave({
  delay = 700,
  save,
  read,
  onStatus = () => {},
  onError = () => {},
  onConflict = () => {},
  onSaved = () => {},
}) {
  let timer = null;
  let baseline = null;   // 最后一次成功写入的快照（回滚依据）
  let inflight = false;
  let disposed = false;

  function setBaseline(v) {
    baseline = v ? { ...v } : null;
  }

  function getBaseline() {
    return baseline;
  }

  async function run(isFlush = false) {
    if (disposed || inflight) return;
    clearTimeout(timer);
    timer = null;
    const payload = read();
    if (!payload) { onStatus('idle'); return; }              // 值不合法（如标题为空），暂不写库
    if (samePayload(baseline, payload)) { onStatus('saved'); return; } // 与基线一致，无需写入

    inflight = true;
    onStatus('saving');
    try {
      const entity = await save(payload);
      if (entity === null || entity === undefined) {
        // 冲突：任务已被删除或不存在 → 回滚到基线并交给宿主处理
        onStatus('error', 'conflict');
        onConflict(baseline);
        return;
      }
      setBaseline(payload);
      onStatus('saved');
      onSaved(entity);
    } catch (e) {
      console.error('[autosave] 保存失败', e);
      onStatus('error', e && e.message);
      onError(e);
    } finally {
      inflight = false;
      // 防抖期间又有新输入 → 立即补一轮
      if (!disposed && !isFlush && timer === null && pendingAgain) {
        pendingAgain = false;
        schedule();
      }
    }
  }

  let pendingAgain = false;

  function schedule() {
    if (disposed) return;
    if (inflight) { pendingAgain = true; onStatus('pending'); return; }
    clearTimeout(timer);
    onStatus('pending');
    timer = setTimeout(() => run(false), delay);
  }

  /** 立即写入（点保存 / 关闭面板 / 失焦时调用） */
  function flush() {
    if (disposed) { return Promise.resolve(); }
    clearTimeout(timer);
    timer = null;
    pendingAgain = false;
    return run(true);
  }

  /** 丢弃尚未写入的改动（如 Esc 取消） */
  function cancel() {
    clearTimeout(timer);
    timer = null;
    pendingAgain = false;
    onStatus('idle');
  }

  function dispose() {
    disposed = true;
    clearTimeout(timer);
    timer = null;
  }

  return { schedule, flush, cancel, dispose, setBaseline, getBaseline };
}

/** 保存状态 → 展示文案 */
export const SAVE_STATE_TEXT = {
  idle: '',
  pending: '未保存',
  saving: '保存中…',
  saved: '已保存',
  error: '保存失败',
};
