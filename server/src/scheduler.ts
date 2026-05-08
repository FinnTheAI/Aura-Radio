/**
 * 由 `routines.md` 衍生的轻量「当日计划」——后续可接真实日历。
 */
export function buildPlanToday(
  now = new Date(),
  tzHeader?: string,
): {
  blocks: Array<{ label: string; start: string; end: string; moodHint?: string }>;
  timezoneNote: string;
} {
  const timezoneNote = tzHeader ? `客户端时区（头）：${tzHeader}` : '未提供 X-Timezone，使用服务器本地生成日期边界。';
  const d = now.toISOString().slice(0, 10);
  return {
    blocks: [
      { label: '苏醒 / 通勤', start: `${d}T07:30:00`, end: `${d}T09:30:00`, moodHint: 'uplift' },
      { label: '深度工作', start: `${d}T09:30:00`, end: `${d}T12:30:00`, moodHint: 'focus' },
      { label: '午间', start: `${d}T12:30:00`, end: `${d}T14:00:00`, moodHint: 'calm' },
      { label: '晚间', start: `${d}T22:00:00`, end: `${d}T23:59:00`, moodHint: 'nostalgic' },
    ],
    timezoneNote,
  };
}
