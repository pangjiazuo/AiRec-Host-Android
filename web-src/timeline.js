// 时间计算独立于界面，按本地日历处理跨午夜及夏令时边界。
export function dayWindow(value) {
  if(typeof value !== 'string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))throw new Error('日期无效');
  const parts = value.split('-').map(Number);
  const start = new Date(parts[0], parts[1] - 1, parts[2]);
  const end = new Date(parts[0], parts[1] - 1, parts[2] + 1);
  if (!Number.isFinite(+start)||start.getFullYear()!==parts[0]||start.getMonth()!==parts[1]-1||start.getDate()!==parts[2]) throw new Error('日期无效');
  return {start: +start, end: +end};
}
export function decodeIndex(data, channel, day, mediaUrl) {
  if (!Array.isArray(data.recordings) || !Array.isArray(data.event_segments) ||
      Date.parse(data.start) !== day.start || Date.parse(data.end) !== day.end) throw new Error('全天录像索引不完整，请重试');
  const recordings = data.recordings.filter(r => r.available).map(r => {
    const start = Date.parse(r.created_at), end = start + Number(r.duration_seconds) * 1000;
    const url = mediaUrl(r.url);
    if (Number(r.channel_id) !== channel || !Number.isFinite(end) || end <= start || !url) throw new Error('录像索引数据无效');
    return {...r, start, end, url};
  }).filter(r => r.start < day.end && r.end > day.start).sort((a,b) => a.start-b.start);
  const events = data.event_segments.map(r => ({start: Date.parse(r.start), end: Date.parse(r.end), type: r.event_type}))
    .filter(r => Number.isFinite(r.start) && r.end > r.start && ['person','vehicle','animal','dwell'].includes(r.type));
  return {recordings, events};
}
export function atTime(recordings, time) { return recordings.find(r => r.start <= time && time < r.end) || null; }

// 只合并用户修改过的字段，避免用旧页面覆盖其他客户端刚刚保存的配置。
export function mergeChanges(original, draft, fresh) {
  if (JSON.stringify(original) === JSON.stringify(draft)) return fresh;
  if (Array.isArray(draft)) {
    if (draft.every(r => r && typeof r === 'object' && 'id' in r)) return fresh.map(r => {
      const old = original.find(v => v.id === r.id), next = draft.find(v => v.id === r.id);
      return old && next ? mergeChanges(old, next, r) : r;
    });
    return draft;
  }
  if (draft && typeof draft === 'object') {
    const result = {...fresh};
    Object.keys(draft).forEach(k => { result[k] = mergeChanges(original && original[k], draft[k], fresh && fresh[k]); });
    return result;
  }
  return draft;
}
