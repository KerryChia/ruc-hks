'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clearDrillAction, draftQuestionAction, gradeQuestionAction, masterQuestionAction, retryQuestionAction, starQuestionAction, submitDrillAction, type DrillOutcome } from '../_lib/actions';
import { optionLabel, type DrillQuestion } from '../_lib/presentation';
import { ensureKatex, katexIsReady, renderRich, richHasMath } from '../_lib/rich';

export type DrillRecord = {
  result: { choice?: string; fields?: boolean[]; correct: boolean } | null;
  draft: string[];
  starred: boolean;
  mastered: boolean;
  everWrong: boolean;
  tries: number;
};
export type DrillRevealed = { explanation: string; correctChoice?: string; displayAnswers?: string[] };
type Filter = 'all' | 'todo' | 'wrong' | 'star';

const FILTERS: [Filter, string][] = [['all', '全部'], ['todo', '未完成'], ['wrong', '错题'], ['star', '收藏']];
const TYPE_LABELS: Record<string, string> = { choice: '单项选择', judge: '判断题', fill: '填空题', subjective: '主观题' };
const emptyRecord = (): DrillRecord => ({ result: null, draft: [], starred: false, mastered: false, everWrong: false, tries: 0 });
const caretToEnd = (input: HTMLInputElement) => {
  try { const n = String(input.value || '').length; input.setSelectionRange(n, n); } catch { /* inputs without selection support */ }
};

const STAR_ICON = (filled: boolean) =>
  <svg viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m12 3 2.8 5.7 6.3.9-4.5 4.4 1.1 6.2L12 17.3l-5.7 3 1.1-6.3L3 9.6l6.3-.9Z" /></svg>;

function fieldHint(kind: string) {
  if (kind === 'sequence') return '序列可写成 [1,2,3] 或 1,2,3，逗号或空格分隔均可。';
  if (kind === 'number') return '填写十进制数值即可。';
  if (kind === 'expression') return '支持全角符号与空格；等价写法以参考答案为准。';
  return '支持等价写法：十六进制带不带 0x、寄存器名带不带 % 都算对。';
}

function Rich({ text, className }: { text: string; className?: string }) {
  const [tick, setTick] = useState(0);
  const html = useMemo(() => renderRich(text), [text, tick]);
  useEffect(() => {
    if (!richHasMath(text) || katexIsReady()) return;
    let alive = true;
    ensureKatex().then(ok => { if (ok && alive) setTick(value => value + 1); });
    return () => { alive = false; };
  }, [text]);
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}

type Props = {
  attemptId: string;
  packId: string;
  packTitle: string;
  packSubtitle: string;
  packNotes: string;
  mode: 'paper' | 'collection';
  questions: DrillQuestion[];
  initialRecords: Record<string, DrillRecord>;
  initialRevealed: Record<string, DrillRevealed>;
  showExplanations: boolean;
  aiAssistant: boolean;
};

type AiMsg = { role: 'user' | 'assistant'; content: string };

export function PracticeDrill({ attemptId, packId, packTitle, packSubtitle, packNotes, mode, questions, initialRecords, initialRevealed, showExplanations, aiAssistant }: Props) {
  const router = useRouter();
  const sessionKey = `examhub-drill-${attemptId}`;
  const byId = useMemo(() => new Map(questions.map(question => [question.id, question])), [questions]);

  const [records, setRecords] = useState<Record<string, DrillRecord>>(() => {
    const stored = questions.map(question => [question.id, initialRecords[question.id] ?? emptyRecord()] as const);
    return Object.fromEntries(stored);
  });
  const [revealed, setRevealed] = useState<Record<string, DrillRevealed>>(initialRevealed);
  const [filter, setFilter] = useState<Filter>(() => {
    try { const saved = JSON.parse(sessionStorage.getItem(sessionKey) ?? '{}'); if (FILTERS.some(([id]) => id === saved.filter)) return saved.filter; } catch { /* fresh session */ }
    return 'all' as Filter;
  });
  const [current, setCurrent] = useState(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(sessionKey) ?? '{}');
      if (typeof saved.current === 'string' && questions.some(question => question.id === saved.current)) return saved.current;
    } catch { /* fresh session */ }
    return questions[0]?.id ?? '';
  });
  const [pendingChoice, setPendingChoice] = useState<string | null>(null);
  const [pendingFilterRefresh, setPendingFilterRefresh] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [sync, setSync] = useState<'ok' | 'busy' | 'error'>('ok');
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [resetting, setResetting] = useState(false);

  const recordsRef = useRef(records);
  recordsRef.current = records;
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const currentRef = useRef(current);
  currentRef.current = current;
  const pendingRef = useRef(pendingChoice);
  pendingRef.current = pendingChoice;
  const busyRef = useRef(false);
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());
  const focusCardRef = useRef(false);
  const cardRef = useRef<HTMLElement | null>(null);
  const draftTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const announce = (message: string) => setAnnouncement(message);

  // Serialize server mutations; failures only flip the sync chip, local state stays.
  const runServer = useCallback(<T,>(work: () => Promise<DrillOutcome<T>>): Promise<DrillOutcome<T>> => {
    const execute = async (): Promise<DrillOutcome<T>> => {
      try {
        const outcome = await work();
        if (!outcome.ok) setSync('error');
        return outcome;
      } catch {
        setSync('error');
        return { ok: false, code: 'UNAVAILABLE', message: '暂时无法完成操作，请稍后重试。' };
      }
    };
    const queued = queueRef.current.then(execute, execute);
    queueRef.current = queued.then(() => undefined, () => undefined);
    return queued;
  }, []);

  const completed = useCallback((question: DrillQuestion, rec: DrillRecord | undefined) =>
    question.qtype === 'subjective' ? Boolean(rec?.mastered) : Boolean(rec?.result), []);

  const visibleList = useMemo(() => questions.filter(question => {
    const rec = records[question.id];
    if (filter === 'todo') return !completed(question, rec);
    if (filter === 'wrong') return Boolean(rec?.everWrong);
    if (filter === 'star') return Boolean(rec?.starred);
    return true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [questions, records, filter, completed]);

  // 未完成/错题筛选下刚作答的题保留在原位，翻题或切筛选后恢复严格筛选。
  const navigationList = useMemo(() => {
    const list = [...visibleList];
    if (pendingFilterRefresh && !list.some(question => question.id === current)) {
      const extra = byId.get(current);
      if (extra && questions.includes(extra)) list.push(extra);
      list.sort((a, b) => questions.indexOf(a) - questions.indexOf(b));
    }
    return list;
  }, [visibleList, pendingFilterRefresh, current, byId, questions]);

  useEffect(() => {
    try { sessionStorage.setItem(sessionKey, JSON.stringify({ current, filter })); } catch { /* private mode */ }
  }, [current, filter, sessionKey]);

  // Focus the card (and the first fill blank) after a programmatic question change.
  useEffect(() => {
    if (!focusCardRef.current) return;
    focusCardRef.current = false;
    const card = cardRef.current;
    if (!card) return;
    const question = byId.get(current);
    const rec = question ? recordsRef.current[question.id] : undefined;
    if (question?.qtype === 'fill' && !rec?.result) {
      const input = card.querySelector<HTMLInputElement>('input[data-field]:not([disabled])');
      if (input) { input.focus({ preventScroll: true }); caretToEnd(input); return; }
    }
    card.focus({ preventScroll: true });
    if (window.innerWidth < 721) card.scrollIntoView({ block: 'start', behavior: 'auto' });
  }, [current, byId]);

  const selectQuestion = useCallback((id: string, focus = false) => {
    if (!byId.has(id)) return;
    setPendingFilterRefresh(false);
    setPendingChoice(null);
    setFormError('');
    focusCardRef.current = focus;
    setCurrent(id);
  }, [byId]);

  const moveRef = useRef<(direction: number) => void>(() => undefined);
  moveRef.current = (direction: number) => {
    const list = navigationList;
    const index = list.findIndex(question => question.id === currentRef.current);
    const target = list[index + direction];
    if (target) selectQuestion(target.id, true);
  };

  // The record that a just-graded/toggled question will hold, used to decide whether
  // it still qualifies under the active filter (反馈保留 until navigation).
  const keepAfter = (questionId: string, next: DrillRecord | undefined) => {
    const question = byId.get(questionId);
    if (!question) return;
    const done = completed(question, next);
    let qualifies = true;
    if (filterRef.current === 'todo') qualifies = !done;
    else if (filterRef.current === 'wrong') qualifies = Boolean(next?.everWrong);
    else if (filterRef.current === 'star') qualifies = Boolean(next?.starred);
    setPendingFilterRefresh(!qualifies);
  };

  const commitChoice = useCallback(async (value: string) => {
    const question = byId.get(currentRef.current);
    if (!question || (question.qtype !== 'choice' && question.qtype !== 'judge') || busyRef.current) return false;
    if (recordsRef.current[question.id]?.result) return false;
    busyRef.current = true;
    setPendingChoice(null);
    setSync('busy');
    const outcome = await runServer(() => gradeQuestionAction({ attemptId, questionId: question.id, choice: value }));
    busyRef.current = false;
    if (outcome.ok) {
      setSync('ok');
      const { result } = outcome.value;
      setRecords(previous => {
        const rec = previous[question.id] ?? emptyRecord();
        return { ...previous, [question.id]: { ...rec, result, everWrong: rec.everWrong || !result.correct, tries: rec.tries + 1 } };
      });
      setRevealed(previous => ({
        ...previous,
        [question.id]: {
          explanation: outcome.value.explanation ?? previous[question.id]?.explanation ?? '',
          correctChoice: outcome.value.correctChoice ?? previous[question.id]?.correctChoice,
          displayAnswers: previous[question.id]?.displayAnswers,
        },
      }));
      keepAfter(question.id, { ...(recordsRef.current[question.id] ?? emptyRecord()), result, everWrong: (recordsRef.current[question.id]?.everWrong ?? false) || !result.correct });
      announce(result.correct ? '答对了，解析已显示。' : '本题答错，正确答案和解析已显示。');
      return true;
    }
    announce('判分失败：' + outcome.message);
    return false;
  }, [announce, attemptId, byId, keepAfter, runServer]);

  // 选择/判断题键盘作答：A–D 或 1–4 选中，回车提交；判断题 1=对 0=错。
  const optionByKey = (question: DrillQuestion, key: string) => {
    if (question.qtype === 'judge') {
      if (key === '1' || key === 'a' || key === 'y') return '0';
      if (key === '0' || key === 'b' || key === 'n') return '1';
      return null;
    }
    let index = 'abcdefgh'.indexOf(key);
    if (index < 0 && /^[1-9]$/.test(key)) index = Number(key) - 1;
    if (index < 0 || index >= question.options.length) return null;
    return String(index);
  };

  const choiceKeysRef = useRef<((event: KeyboardEvent) => boolean)>(() => false);
  choiceKeysRef.current = (event: KeyboardEvent) => {
    const question = byId.get(currentRef.current);
    if (!question || (question.qtype !== 'choice' && question.qtype !== 'judge')) return false;
    if (recordsRef.current[question.id]?.result) return false;
    if (event.key === 'Enter') {
      if (!pendingRef.current) return false;
      void commitChoice(pendingRef.current);
      return true;
    }
    const key = String(event.key || '').toLowerCase();
    if (!/^[0-9a-z]$/.test(key)) return false;
    const value = optionByKey(question, key);
    if (!value) return false;
    setPendingChoice(value);
    const label = question.qtype === 'judge'
      ? (value === '0' ? '正确' : '错误')
      : optionLabel(value) + '．' + (question.options[Number(value)] ?? '');
    announce('已选 ' + label + '，按回车确认。');
    event.preventDefault();
    return true;
  };

  // 键盘翻题（← →）：翻页后直接进入填空输入框；在输入框首尾继续翻。
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target as HTMLElement | null;
      const field = target && (target as HTMLInputElement).matches?.('input[data-field]') ? target as HTMLInputElement : null;
      if (field) {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        const form = field.closest('form');
        const inputs = form ? Array.from(form.querySelectorAll<HTMLInputElement>('input[data-field]')) : [field];
        const index = inputs.indexOf(field);
        const atStart = field.selectionStart === 0 && field.selectionEnd === 0;
        const atEnd = field.selectionStart === field.value.length && field.selectionEnd === field.value.length;
        if (event.key === 'ArrowRight' && atEnd) {
          if (index >= 0 && index < inputs.length - 1) { const next = inputs[index + 1]; next.focus({ preventScroll: true }); caretToEnd(next); }
          else moveRef.current(1);
          event.preventDefault();
        } else if (event.key === 'ArrowLeft' && atStart) {
          if (index > 0) { const previous = inputs[index - 1]; previous.focus({ preventScroll: true }); caretToEnd(previous); }
          else moveRef.current(-1);
          event.preventDefault();
        }
        return;
      }
      if (target && target.matches?.('input, textarea, select')) return;
      if (target && target.isContentEditable) return;
      if (choiceKeysRef.current(event)) return;
      if (event.key === 'ArrowLeft') { moveRef.current(-1); event.preventDefault(); }
      else if (event.key === 'ArrowRight') { moveRef.current(1); event.preventDefault(); }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  const scheduleDraftSave = (questionId: string) => {
    clearTimeout(draftTimers.current[questionId]);
    draftTimers.current[questionId] = setTimeout(() => {
      const rec = recordsRef.current[questionId];
      if (!rec || rec.result) return;
      setSync('busy');
      void runServer(() => draftQuestionAction({ attemptId, questionId, draft: rec.draft.map(String) })).then(outcome => {
        if (outcome.ok) setSync('ok');
      });
    }, 900);
  };

  const setDraftValue = (question: DrillQuestion, index: number, value: string) => {
    setRecords(previous => {
      const rec = previous[question.id] ?? emptyRecord();
      if (rec.result) return previous;
      const draft = [...rec.draft];
      draft[index] = value;
      return { ...previous, [question.id]: { ...rec, draft } };
    });
    scheduleDraftSave(question.id);
  };

  const submitFill = async (question: DrillQuestion) => {
    const rec = recordsRef.current[question.id];
    if (rec?.result || busyRef.current) return;
    const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('#question-card input[data-field]'));
    const empty = inputs.find(input => !input.value.trim());
    if (empty) { setFormError('请先填写全部空格，再提交核对。'); empty.focus(); return; }
    setFormError('');
    busyRef.current = true;
    setSync('busy');
    const values = question.fields.map((_, index) => rec.draft[index] ?? inputs[index]?.value ?? '');
    const outcome = await runServer(() => gradeQuestionAction({ attemptId, questionId: question.id, values }));
    busyRef.current = false;
    if (outcome.ok) {
      setSync('ok');
      const { result } = outcome.value;
      setRecords(previous => {
        const existing = previous[question.id] ?? emptyRecord();
        return { ...previous, [question.id]: { ...existing, result, draft: [...values], everWrong: existing.everWrong || !result.correct, tries: existing.tries + 1 } };
      });
      setRevealed(previous => ({
        ...previous,
        [question.id]: { explanation: outcome.value.explanation ?? previous[question.id]?.explanation ?? '', displayAnswers: outcome.value.displayAnswers ?? previous[question.id]?.displayAnswers },
      }));
      keepAfter(question.id, { ...(recordsRef.current[question.id] ?? emptyRecord()), result, everWrong: (recordsRef.current[question.id]?.everWrong ?? false) || !result.correct });
      announce(result.correct ? '全部填空正确，解析已显示。' : '已完成核对，请查看逐空结果和解析。');
      return;
    }
    announce('判分失败：' + outcome.message);
  };

  const toggleStar = async (question: DrillQuestion) => {
    const rec = recordsRef.current[question.id] ?? emptyRecord();
    const starred = !rec.starred;
    setRecords(previous => ({ ...previous, [question.id]: { ...(previous[question.id] ?? emptyRecord()), starred } }));
    keepAfter(question.id, { ...rec, starred });
    announce(starred ? '已收藏本题。' : '已取消收藏本题。');
    setSync('busy');
    const outcome = await runServer(() => starQuestionAction({ attemptId, questionId: question.id, starred }));
    if (outcome.ok) setSync('ok');
  };

  const toggleMastered = async (question: DrillQuestion) => {
    const rec = recordsRef.current[question.id] ?? emptyRecord();
    const mastered = !rec.mastered;
    setRecords(previous => ({ ...previous, [question.id]: { ...(previous[question.id] ?? emptyRecord()), mastered } }));
    keepAfter(question.id, { ...rec, mastered });
    announce(mastered ? '已标记掌握。' : '已撤销掌握标记。');
    setSync('busy');
    const outcome = await runServer(() => masterQuestionAction({ attemptId, questionId: question.id, mastered }));
    if (outcome.ok) setSync('ok');
  };

  const retry = async (question: DrillQuestion) => {
    setRecords(previous => ({ ...previous, [question.id]: { ...(previous[question.id] ?? emptyRecord()), result: null } }));
    setFormError('');
    keepAfter(question.id, { ...(recordsRef.current[question.id] ?? emptyRecord()), result: null });
    setSync('busy');
    const outcome = await runServer(() => retryQuestionAction({ attemptId, questionId: question.id }));
    if (outcome.ok) setSync('ok');
    requestAnimationFrame(() => {
      const first = document.querySelector<HTMLTextAreaElement>('#question-card textarea') ?? document.querySelector<HTMLInputElement | HTMLButtonElement>('#question-card input[data-field]:not([disabled]), #question-card [data-answer]');
      first?.focus();
    });
  };

  const resetAll = async () => {
    if (!window.confirm(`清空本组全部答题记录（含错题标记与收藏）？此操作不能撤销。`)) return;
    setResetting(true);
    const outcome = await runServer(() => clearDrillAction({ attemptId }));
    setResetting(false);
    if (!outcome.ok) { announce('清空失败：' + outcome.message); return; }
    setRecords(Object.fromEntries(questions.map(question => [question.id, emptyRecord()])));
    setRevealed({});
    setPendingFilterRefresh(false);
    setFilter('all');
    setCurrent(questions[0]?.id ?? '');
    announce('全部答题记录已清空。');
  };

  const submit = async () => {
    const remaining = questions.filter(question => !completed(question, records[question.id])).length;
    if (remaining > 0 && !window.confirm(`还有 ${remaining} 道题未作答，确定要交卷吗？`)) return;
    setSubmitting(true);
    setSync('busy');
    const outcome = await runServer(() => submitDrillAction({ attemptId }));
    if (outcome.ok) {
      setSync('ok');
      router.push(`/attempts/${attemptId}`);
      router.refresh();
      return;
    }
    setSubmitting(false);
    announce('交卷失败：' + outcome.message);
  };

  // 每题内嵌 AI 助教：对话仅存内存（与参考实现一致），上下文由服务端按权限拼装。
  const [aiHistory, setAiHistory] = useState<Record<string, AiMsg[]>>({});
  const [aiInput, setAiInput] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const aiBusyRef = useRef(false);
  aiBusyRef.current = aiBusy;

  const replaceLastAi = (questionId: string, content: string) => {
    setAiHistory(previous => {
      const list = previous[questionId] ?? [];
      if (!list.length || list[list.length - 1].role !== 'assistant') return previous;
      return { ...previous, [questionId]: [...list.slice(0, -1), { role: 'assistant', content }] };
    });
  };

  const sendAsk = async (question: DrillQuestion) => {
    const text = aiInput.trim();
    if (!text || aiBusyRef.current) return;
    setAiInput('');
    const previous = aiHistory[question.id] ?? [];
    setAiHistory(previousState => ({ ...previousState, [question.id]: [...previous, { role: 'user', content: text }, { role: 'assistant', content: '' }] }));
    setAiBusy(true);
    let bot = '';
    try {
      const response = await fetch('/api/ask', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attemptId, questionId: question.id, text, history: previous.slice(-8) }),
      });
      if (!response.ok || !response.body) {
        const data = await response.json().catch(() => ({}));
        replaceLastAi(question.id, '**出错了。** ' + ((data as { message?: string }).message ?? `HTTP ${response.status}`));
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let flushPending = false;
      const flush = () => { flushPending = false; replaceLastAi(question.id, bot); };
      const schedule = () => { if (!flushPending) { flushPending = true; setTimeout(flush, 90); } };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const raw = buffer.slice(0, boundary).trim();
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf('\n\n');
          if (!raw.startsWith('data:')) continue;
          let event: { type?: string; text?: string };
          try { event = JSON.parse(raw.slice(5)) as typeof event; } catch { continue; }
          if (event.type === 'content') { bot += event.text ?? ''; schedule(); }
          else if (event.type === 'error') { bot += (bot ? '\n\n' : '') + '**出错了。** ' + (event.text ?? ''); schedule(); }
        }
      }
      replaceLastAi(question.id, bot.trim() || '**出错了。** 流式响应为空，请重试。');
    } catch {
      replaceLastAi(question.id, bot.trim() ? bot + '\n\n**网络中断。** 请稍后重试。' : '**网络异常。** 请稍后重试。');
    } finally {
      setAiBusy(false);
    }
  };

  const copyQuestion = async (question: DrillQuestion) => {
    const rec = recordsRef.current[question.id] ?? emptyRecord();
    const rev = revealed[question.id];
    const lines = [`【${TYPE_LABELS[question.qtype]}】${question.stem}`];
    if (question.body) lines.push(question.body);
    if (question.qtype === 'choice' || question.qtype === 'judge') {
      lines.push(...question.options.map((option, index) => `${optionLabel(String(index))}. ${option}`));
    } else if (question.qtype === 'fill') {
      lines.push(...question.fields.map((field, index) => `第${index + 1}空 · ${field.label}`));
    }
    if (rev?.explanation) {
      if (question.qtype === 'choice' || question.qtype === 'judge') {
        const picked = rec.result?.choice;
        lines.push(`我的答案：${picked === undefined ? '未作答' : optionLabel(picked)}`);
        lines.push(`正确答案：${optionLabel(rev.correctChoice ?? '')}`);
      } else if (question.qtype === 'fill' && rec.result) {
        lines.push(`逐空结果：${rec.result.fields?.map(valid => valid ? '对' : '错').join(' / ') ?? ''}`);
        if (rev.displayAnswers) lines.push(`参考答案：${rev.displayAnswers.join(' / ')}`);
      }
      lines.push(`解析：${rev.explanation}`);
    }
    try { await navigator.clipboard.writeText(lines.join('\n\n')); announce('已复制本题内容。'); }
    catch { announce('复制失败，请手动选择文本。'); }
  };

  const changeFilter = (value: Filter) => {
    setFilter(value);
    setPendingFilterRefresh(false);
    const list = questions.filter(question => {
      const rec = records[question.id];
      if (value === 'todo') return !completed(question, rec);
      if (value === 'wrong') return Boolean(rec?.everWrong);
      if (value === 'star') return Boolean(rec?.starred);
      return true;
    });
    if (!list.some(question => question.id === current)) setCurrent(list[0]?.id ?? '');
  };

  const group = questions;
  const doneCount = group.filter(question => completed(question, records[question.id])).length;
  const objective = group.filter(question => question.qtype !== 'subjective');
  const objCorrect = objective.filter(question => records[question.id]?.result?.correct).length;
  const attempted = objective.filter(question => records[question.id]?.result).length;
  const percent = group.length ? Math.round(doneCount / group.length * 100) : 0;
  const position = navigationList.findIndex(question => question.id === current);
  const question = byId.get(current);
  const rec = question ? (records[question.id] ?? emptyRecord()) : undefined;
  const rev = question ? revealed[question.id] : undefined;
  const filterCount = visibleList.length;
  const syncText = sync === 'busy' ? '☁ 同步中…' : sync === 'error' ? '☁ 离线·待重试' : '☁ 已同步到服务器';
  const stemHTML = question ? renderRich(question.stem).replace(/_{4,}/g, '<span class="dr-blank" aria-label="待填写的空白"></span>') : '';

  return <div className="drill">
    <a className="dr-skip" href="#question-card">跳到题目</a>
    <div className="dr-layout">
      <aside className="dr-sidebar" aria-label="答题进度与题号导航">
        <section className="dr-panel">
          <h2 id="dr-pack-name">{packTitle}</h2>
          <p id="dr-pack-subtitle" className="dr-pack-subtitle">{packSubtitle}</p>
          <div className="dr-stats">
            <div><div className="dr-stat-number">{doneCount} / {group.length}</div><div className="dr-stat-label">已完成 / 本组题数</div></div>
            <div><div className="dr-stat-number">{objCorrect} / {attempted}</div><div className="dr-stat-label">客观题答对</div></div>
          </div>
          <div className="dr-progress" role="progressbar" aria-label="当前组完成进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><span style={{ width: `${percent}%` }} /></div>
          <p className="dr-progress-caption">完成度 {percent}% · 主观题需自行标记掌握</p>
          <div className="dr-map" aria-label="题号导航">
            {navigationList.map(item => {
              const itemRec = records[item.id] ?? emptyRecord();
              const stateClass = itemRec.result ? (itemRec.result.correct ? 'right' : 'wrong') : itemRec.mastered ? 'read' : '';
              const stateText = itemRec.result ? (itemRec.result.correct ? '答对' : '答错') : itemRec.mastered ? '已掌握' : '未完成';
              const label = item.ref ?? String(item.seq);
              return <button type="button" key={item.id} onClick={() => selectQuestion(item.id, true)}
                className={`dr-map-btn ${stateClass} ${item.id === current ? 'active' : ''} ${itemRec.starred ? 'star' : ''}`}
                aria-label={`${label}，${stateText}${itemRec.starred ? '，已收藏' : ''}`} aria-current={item.id === current || undefined}>{label}</button>;
            })}
          </div>
          <div className="dr-legend"><span><i className="g" />答对</span><span><i className="r" />答错</span><span><i className="b" />主观已掌握</span></div>
          <p className="dr-save-label" role="status">{syncText}</p>
          <button className="dr-reset-all" type="button" onClick={resetAll} disabled={resetting}>清空本组答题记录</button>
        </section>
        <section className="dr-panel dr-submit-panel">
          <h2>交卷</h2>
          <p className="dr-note">已作答 <strong>{attempted + group.filter(item => item.qtype === 'subjective' && ((records[item.id]?.draft[0] ?? '').trim() || records[item.id]?.mastered)).length}</strong> / {group.length} 题。{mode === 'paper' ? '交卷后出成绩并计入练习榜单。' : '题集作答不计入榜单，交卷后仍可查看解析。'}</p>
          <button className="dr-btn primary" type="button" onClick={submit} disabled={submitting}>{submitting ? '正在交卷…' : '交卷，查看成绩 →'}</button>
        </section>
      </aside>
      <main className="dr-main">
        {packNotes && <details className="dr-inst-notes dr-pack-notes"><summary>📖 {packTitle} 知识点梳理（做题前先读一遍）</summary><Rich text={packNotes} className="dr-rich" /></details>}
        <div className="dr-toolbar">
          <div className="dr-filters" role="group" aria-label="筛选题目">
            {FILTERS.map(([id, label]) => <button type="button" key={id} className={`dr-filter ${filter === id ? 'active' : ''}`} aria-pressed={filter === id} onClick={() => changeFilter(id)}>{label}</button>)}
          </div>
          <span className="dr-filter-count">当前分组 · {filterCount}题{pendingFilterRefresh ? '（本题反馈保留）' : ''}</span>
        </div>
        <article id="question-card" className="dr-question-card" tabIndex={-1} ref={cardRef as React.RefObject<HTMLElement>}>
          {!question || !navigationList.some(item => item.id === current) ? <div className="dr-empty">
            <p className="dr-eyebrow">留一点时间给真正的薄弱点</p>
            <h2>{filter === 'todo' ? '这一组完成了。' : '这里暂时没有题目。'}</h2>
            <p>{{ todo: '当前分组已经全部完成。你可以回看解析，或切换下一卷。', wrong: '当前分组还没有错题。首次答错的题会保留在这里，重做答对后也方便复盘。', star: '点击题目右上角的“收藏”，就能在这里集中复习。', all: '请切换分组后继续练习。' }[filter]}</p>
            <button className="dr-btn primary" type="button" onClick={() => changeFilter('all')}>返回本组全部题目</button>
          </div> : <>
            <div className="dr-question-top">
              <div className="dr-q-meta">
                <span className="dr-qid">{question.ref ?? String(question.seq).padStart(2, '0')}</span>
                <span className="dr-badge">{TYPE_LABELS[question.qtype]}</span>
                {rec?.everWrong && <span className="dr-badge">错题记录</span>}
              </div>
              <div className="dr-q-actions">
                <button type="button" className="dr-copy-top" data-action="copy" onClick={() => copyQuestion(question)} aria-label="复制本题题干、选项、答案与解析" title="复制本题：题干 + 选项 +（答案与解析，判分后可用）">复制</button>
                <button type="button" className={`dr-star-button ${rec?.starred ? 'on' : ''}`} data-action="star" aria-pressed={rec?.starred ?? false} aria-label={`${rec?.starred ? '取消收藏' : '收藏'} ${question.ref ?? question.seq}`} onClick={() => toggleStar(question)}>{STAR_ICON(rec?.starred ?? false)}{rec?.starred ? '已收藏' : '收藏'}</button>
              </div>
            </div>
            <h2 className="dr-stem" id="dr-stem-heading"><span dangerouslySetInnerHTML={{ __html: stemHTML }} /></h2>
            {question.body && <Rich text={question.body} className="dr-rich dr-question-body" />}
            {(question.qtype === 'choice' || question.qtype === 'judge') && <>
              <div className={`dr-answer-options ${question.qtype === 'judge' ? 'dr-judge-options' : ''}`} role="group" aria-labelledby="dr-stem-heading">
                {question.options.map((option, index) => {
                  const value = String(index);
                  const selected = rec?.result ? rec.result.choice === value : pendingChoice === value;
                  // 未授权视图不返回 correctChoice，因此不标出正确选项，只标红错选。
                  const showRight = Boolean(rec?.result) && rev?.correctChoice === value;
                  const showWrong = Boolean(rec?.result) && rec?.result?.choice === value && !rec.result.correct;
                  const mark = showRight ? '正确答案' : showWrong ? '你的选择' : '';
                  return <button type="button" key={index} className={`dr-option ${selected && !rec?.result ? 'selected' : ''} ${showRight ? 'right' : ''} ${showWrong ? 'wrong' : ''}`}
                    data-answer={value} disabled={Boolean(rec?.result)} aria-pressed={Boolean(selected)}
                    onClick={() => { if (rec?.result) return; void commitChoice(value); }}>
                    <span className="dr-letter">{question.qtype === 'judge' ? (value === '0' ? '✓' : '×') : optionLabel(value)}</span>
                    <span className="dr-option-text">{option}</span>
                    {mark && <span className="dr-result-tag">{mark}</span>}
                  </button>;
                })}
              </div>
              {rec?.result ? <div className="dr-actions"><button type="button" className="dr-btn" onClick={() => retry(question)}>重新作答</button></div>
                : <p className="dr-input-tip">点选，或按 A–D／1–4（判断题 1=对、0=错）选中后回车提交。</p>}
            </>}
            {question.qtype === 'fill' && <form noValidate onSubmit={event => { event.preventDefault(); void submitFill(question); }}>
              <div className="dr-form-fields">
                {question.fields.map((field, index) => {
                  const value = rec?.draft[index] ?? '';
                  const valid = rec?.result?.fields?.[index];
                  const cls = rec?.result ? (valid ? 'correct' : 'incorrect') : '';
                  const display = rec?.result ? (valid ? '正确' : (rev?.displayAnswers?.[index] ? `参考答案：${rev.displayAnswers[index]}` : '参考答案需授权')) : fieldHint(field.kind);
                  return <div className="dr-field" key={index}>
                    <label htmlFor={`dr-fill-${index}`}>第{index + 1}空 · {field.label}</label>
                    <input id={`dr-fill-${index}`} name={`dr-fill-${index}`} data-field={index} value={value} autoComplete="off" maxLength={500} spellCheck={false}
                      disabled={Boolean(rec?.result)} className={cls} aria-describedby={`dr-field-note-${index}`}
                      onChange={event => setDraftValue(question, index, event.target.value)} />
                    <span id={`dr-field-note-${index}`} className={`dr-field-note ${cls}`}>{display}</span>
                  </div>;
                })}
              </div>
              <p className="dr-input-tip">填写全部空格后提交。中文标点和空格通常不影响核对；判分按字符归一化，并非语义理解。</p>
              <div className="dr-actions">
                {rec?.result ? <button type="button" className="dr-btn" onClick={() => retry(question)}>修改答案并重做</button>
                  : <button className="dr-btn primary" type="submit">提交答案并查看解析</button>}
                <button type="button" className="dr-btn" onClick={() => moveRef.current(1)} disabled={position < 0 || position >= navigationList.length - 1} aria-label="跳到下一题">下一题 →</button>
              </div>
              {formError && <p className="dr-field-note incorrect" role="alert">{formError}</p>}
            </form>}
            {question.qtype === 'subjective' && <>
              <p className="dr-subjective-tip">主观题：先在下方写下你的作答（自动同步到服务器），再对照参考答案。</p>
              <textarea id="dr-subj-answer" data-subj-draft placeholder="在此写下你的作答…（内容实时保存）" value={rec?.draft[0] ?? ''}
                onChange={event => setDraftValue(question, 0, event.target.value)} />
              {showExplanations ? <section className="dr-explanation" aria-labelledby="dr-explanation-heading">
                <h3 id="dr-explanation-heading">参考答案与解题思路</h3>
                <Rich text={rev?.explanation ?? ''} className="dr-rich" />
              </section> : <section className="dr-explanation"><h3>参考答案</h3><p className="dr-locked">取得练习授权后可查看参考答案。<Link href={`/packs/${packId}`}>查看题包授权</Link></p></section>}
              <div className="dr-actions">
                <button type="button" className={`dr-btn ${rec?.mastered ? '' : 'primary'}`} data-action="mastered" aria-pressed={rec?.mastered ?? false} onClick={() => toggleMastered(question)}>{rec?.mastered ? '已掌握 · 点击撤销' : '标记为已掌握'}</button>
              </div>
            </>}
            {rec?.result && (question.qtype === 'choice' || question.qtype === 'judge' || question.qtype === 'fill') && <div className={`dr-feedback ${rec.result.correct ? 'correct' : 'incorrect'}`} role="status">
              <strong>{rec.result.correct ? '答对了。' : '这道题还需要再看一遍。'}</strong>
              <span>{question.qtype === 'fill'
                ? `本题 ${rec.result.fields?.filter(Boolean).length ?? 0} / ${question.fields.length} 空正确。输入格式不同不等于思路错误，请核对下方标准答案。`
                : `你的答案：${question.qtype === 'judge' ? (rec.result.choice === '0' ? '正确' : '错误') : optionLabel(rec.result.choice ?? '')}；正确答案：${rev?.correctChoice === undefined ? '需授权后查看' : question.qtype === 'judge' ? (rev.correctChoice === '0' ? '正确' : '错误') : optionLabel(rev.correctChoice)}。`}</span>
            </div>}
            {(rec?.result || question.qtype === 'subjective') && rev?.explanation && question.qtype !== 'subjective' && <section className="dr-explanation" aria-labelledby="dr-explanation-heading">
              <h3 id="dr-explanation-heading">答案解析</h3>
              <Rich text={rev.explanation} className="dr-rich" />
            </section>}
            {rec?.result && !rev?.explanation && !showExplanations && question.qtype !== 'subjective' && <section className="dr-explanation"><h3>答案解析</h3>
              <p className="dr-locked">取得练习授权后可查看解析。<Link href={`/packs/${packId}`}>查看题包授权</Link></p>
            </section>}
            {aiAssistant && <div className="dr-ai-panel">
              <div className="dr-ai-panel-head"><div><span className="dr-ai-panel-title">🤖 AI 助教</span>
                <span className="dr-ai-panel-hint"> · 已自动附带本题原文与你的作答{showExplanations ? '与解析' : ''} · Enter 发送，Shift+Enter 换行</span></div></div>
              <div className="dr-ai-msgs">
                {(aiHistory[question.id] ?? []).map((message, index) => message.role === 'user'
                  ? <div className="dr-ai-msg user" key={index}>{message.content}</div>
                  : <div className="dr-ai-msg bot" key={index}>{message.content ? <Rich text={message.content} className="dr-rich" /> : <span className="dr-ai-typing">AI 助教思考中…</span>}</div>)}
              </div>
              <div className="dr-ai-inputrow">
                <textarea className="dr-ai-input" rows={2} value={aiInput} placeholder="就本题问点什么…（Enter 发送，Shift+Enter 换行）"
                  onChange={event => setAiInput(event.target.value)}
                  onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void sendAsk(question); } }} />
                <button type="button" className="dr-btn primary dr-ai-send" disabled={aiBusy} onClick={() => void sendAsk(question)}>{aiBusy ? '思考中…' : '发送'}</button>
              </div>
            </div>}
          </>}
        </article>
        <nav className="dr-pager" aria-label="上一题和下一题">
          <button id="dr-prev" className="dr-btn" type="button" onClick={() => moveRef.current(-1)} disabled={position <= 0}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m14 6-6 6 6 6" /></svg> 上一题
          </button>
          <span className="dr-page-position">{position >= 0 ? `${position + 1} / ${navigationList.length} · ${FILTERS.find(([id]) => id === filter)?.[1] ?? '当前分组'}` : '没有符合条件的题目'}</span>
          <button id="dr-next" className="dr-btn" type="button" onClick={() => moveRef.current(1)} disabled={position < 0 || position >= navigationList.length - 1}>
            下一题 <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m10 6 6 6-6 6" /></svg>
          </button>
        </nav>
      </main>
    </div>
    <div className="dr-sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</div>
  </div>;
}
