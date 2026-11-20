import type { PublicQuestion, QuestionKind } from '../../src/domains/catalog';

// The drill client only ever sees the public question surface: labels and kinds of
// fill blanks, never answers, accepted alternatives or explanations.
export type DrillQuestion = { id: string; seq: number; ref: string | null; qtype: QuestionKind; stem: string; body: string; options: string[]; fields: { label: string; kind: string }[]; tags: string[] };

export function drillQuestions(rows: readonly PublicQuestion[]): DrillQuestion[] {
  return rows.map(({ id, seq, ref, qtype, stem, body, options, fields, tags }) => ({
    id, seq, ref, qtype, stem, body, options: [...options], tags: [...tags],
    fields: fields.map(({ label, kind }) => ({ label, kind })),
  }));
}

export const MCP_SCOPES = [
  ['profile:read', '读取账户资料'], ['packs:read', '浏览题库'], ['packs:acquire', '发起题包授权请求'],
  ['attempts:write', '开始作答、交卷'], ['attempts:read', '读取作答与成绩'], ['credits:read', '读取余额'],
] as const;

export function readScopes(values: FormDataEntryValue[]): string[] {
  return MCP_SCOPES.map(([scope]) => scope).filter(scope => values.includes(scope));
}

const sharing = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium' });

// The copy-paste paragraph is the whole product surface of a handoff code, so it carries
// the endpoint, the allowed actions and the boundaries in one block the user can forward.
export function buildHandoffMessage(input: {
  code: string; mode: 'pack' | 'catalog'; packTitle?: string | null;
  priceCc: number; budgetCc: number; expiresAt: Date;
}) {
  const origin = process.env.EXAMHUB_PUBLIC_ORIGIN ?? 'https://examhub.kerrychia.site';
  const deadline = sharing.format(input.expiresAt);
  const lines = input.mode === 'pack' ? [
    `用 ExamHub 帮我做这套题：${input.packTitle ?? '我选的这套题'}`,
    `口令：${input.code}`,
    '',
    `接入：把这个口令当作 Bearer 令牌，连接 ${origin}/api/mcp（MCP Streamable HTTP，不需要 OAuth）。`,
    `第一步调用 handoff_status 确认题目与费用；第二步调用 open_pack 取题${input.priceCc > 0 ? `（本次最多扣 ${input.priceCc} CC；仍在免费额度内则不扣）` : '（限时免费，不扣 CC）'}。`,
    '拿到题目后，请用你自己的模型逐题讲解、追问、按知识点补练习；交卷调用 submit_attempt，之后可以用 get_grading_rubric 复盘错题。',
    '',
    `边界：口令在 ${deadline} 前有效，只对应这一套题；开卷后 2 小时内可交卷。不要转发到群聊，也不要把口令回显给我。`,
  ] : [
    '用 ExamHub 当我的题库助手。',
    `口令：${input.code}`,
    '',
    `接入：把这个口令当作 Bearer 令牌，连接 ${origin}/api/mcp（MCP Streamable HTTP，不需要 OAuth）。`,
    `第一步调用 handoff_status 看预算（共 ${input.budgetCc} CC）；第二步用 list_packs 找题，选中后 open_pack 购买并取题（每套 5 CC，从预算里扣）；然后用你自己的模型讲解、批改，交卷调用 submit_attempt。`,
    '',
    `边界：这个口令只能买一套题，预算用完即止，${deadline} 前有效。不要转发到群聊，也不要把口令回显给我。`,
  ];
  return lines.join('\n');
}

export const SESSION_COOKIE = 'examhub_session';export function sessionCookie(secureSetting: string | undefined) {
  return { httpOnly: true, sameSite: 'lax' as const, secure: secureSetting === '1', path: '/' };
}

const date = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
const currency = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' });
export function formatDate(value: unknown) {
  const parsed = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  return parsed && Number.isFinite(+parsed) ? date.format(parsed) : '—';
}
export const formatCents = (value: number) => currency.format(value / 100);
export const segment = (value: string) => encodeURIComponent(value);
export const courseHref = (slug: string) => `/${segment(slug)}`;
export const courseRedirectLocation = (slug: string, search: string) => `${courseHref(slug)}${search}`;
export function decodeCourseParam(value: string): string | null {
  try { return decodeURIComponent(value); }
  catch { return null; }
}
export const campusName = (value: unknown) => ({ haidian: '海淀', zhongguancun: '中关村', tongzhou: '通州', suzhou: '苏州', all: '全校' }[String(value)] ?? (value || '未设置')) as string;
export const licenseName = (value: unknown) => ({ practice: '练习', read: '阅读', collection: '题集' }[String(value)] ?? '授权');
export const statusName = (value: string) => ({
  draft: '草稿', open: '作答中', submitted: '已交卷',
  live: '已发布', reviewing: '待审核', pending_review: '待审核', delisted: '已下架',
  approved: '已通过', rejected: '已驳回', created: '待模拟付款', awaiting_payment: '待模拟付款',
  paid: '已模拟付款', simulated_paid: '待审核入账', paid_pending: '待审核入账', credited: '已入账', expired: '已过期',
}[value] ?? value);

export function sourceName(value: string) {
  return ({ mock: '合成示例', past_exam: '往年资料', courseware: '课程练习', full_kit: '综合题集' } as Record<string, string>)[value] ?? '练习资料';
}

export function optionLabel(value: string | null | undefined) {
  if (!value || !/^(0|[1-9]\d*)$/.test(value)) return '未作答';
  const index = Number(value);
  return index < 26 ? String.fromCharCode(65 + index) : `选项 ${index + 1}`;
}
