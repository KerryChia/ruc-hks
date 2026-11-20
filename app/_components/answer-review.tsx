'use client';

import { useEffect, useMemo, useState } from 'react';
import { Badge, Empty } from './ui';
import { optionLabel } from '../_lib/presentation';
import { renderRich, richHasMath, ensureKatex, katexIsReady } from '../_lib/rich';

type ReviewRow = {
  id: string; seq: number; ref: string | null; qtype: string; stem: string; body: string;
  state: 'correct' | 'wrong' | 'subjective';
  yourAnswer: string | string[] | null;
  correctAnswer: string | null;
  correctText?: string;
  fieldResults?: boolean[];
  explanation: string; tags: string[];
};
type Filter = 'all' | 'wrong' | 'correct';

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

export function ScoreReveal({ score }: { score: number }) {
  const [display, setDisplay] = useState(0);
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setDisplay(score); return; }
    let frame = 0;
    const start = performance.now();
    const tick = (time: number) => {
      const progress = Math.min(1, (time - start) / 850);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(score * eased);
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    // Background tabs never fire rAF; settle on the final score regardless.
    const settle = setTimeout(() => setDisplay(score), 1000);
    return () => { cancelAnimationFrame(frame); clearTimeout(settle); };
  }, [score]);
  return <strong className="score-number">{Number.isInteger(score) ? Math.round(display) : display.toFixed(2)}</strong>;
}

const answerSummary = (row: ReviewRow) => {
  if (row.yourAnswer === null || row.yourAnswer === undefined) return '未作答';
  if (Array.isArray(row.yourAnswer)) return row.yourAnswer.join('　');
  if (row.qtype === 'judge') return row.yourAnswer === '0' ? '正确' : '错误';
  if (row.qtype === 'choice') return optionLabel(row.yourAnswer);
  return row.yourAnswer.length > 120 ? `${row.yourAnswer.slice(0, 120)}…` : row.yourAnswer;
};

export function AnswerReview({ rows }: { rows: ReviewRow[] }) {
  const [filter, setFilter] = useState<Filter>('all');
  const objectiveRows = rows.filter(row => row.state !== 'subjective');
  const wrongCount = objectiveRows.filter(row => row.state === 'wrong').length;
  const correctCount = objectiveRows.length - wrongCount;
  const visible = rows.filter(row => filter === 'all' || (filter === 'correct') === (row.state === 'correct'));
  return <>
    <div className="review-toolbar"><div className="review-filters" aria-label="筛选解析">
      <button type="button" className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')} aria-pressed={filter === 'all'}>全部 <span>{rows.length}</span></button>
      <button type="button" className={filter === 'wrong' ? 'active' : ''} onClick={() => setFilter('wrong')} aria-pressed={filter === 'wrong'}>答错 <span>{wrongCount}</span></button>
      <button type="button" className={filter === 'correct' ? 'active' : ''} onClick={() => setFilter('correct')} aria-pressed={filter === 'correct'}>答对 <span>{correctCount}</span></button>
    </div><small>点击题目卡片，回顾你的思路</small></div>
    <div className="review-list">{visible.length === 0 ? <Empty>这个分类下暂无题目。</Empty> : visible.map(row => {
      const correct = row.state === 'correct';
      return <article className={`panel explanation ${row.state === 'subjective' ? 'answer-subjective' : correct ? 'answer-correct' : 'answer-wrong'}`} key={row.id}>
        <div className="answer-state">{row.state === 'subjective' ? '✎ 主观题 · 对照参考答案自评' : correct ? '✓ 回答正确' : '↗ 再复习一下'}</div>
        <h3><span className="question-number">{String(row.seq).padStart(2, '0')}</span><span dangerouslySetInnerHTML={{ __html: renderRich(row.stem) }} /></h3>
        {row.body && <Rich text={row.body} className="rich" />}
        <div className="inline">
          <Badge positive={row.state === 'subjective' ? undefined : correct}>你的答案：{answerSummary(row)}</Badge>
          {row.qtype === 'choice' && row.correctAnswer !== null && <Badge positive>参考答案：{optionLabel(row.correctAnswer)}{row.correctText ? ` · ${row.correctText}` : ''}</Badge>}
          {row.qtype === 'judge' && <Badge positive>参考答案：{row.correctAnswer === '0' ? '正确' : '错误'}</Badge>}
          {row.qtype === 'fill' && row.correctText && <Badge positive>参考答案：{row.correctText}</Badge>}
        </div>
        {row.fieldResults && <p className="muted">逐空结果：{row.fieldResults.map(valid => valid ? '对' : '错').join(' / ')}</p>}
        <Rich text={row.explanation} className="rich" />
        {row.tags.length > 0 && <p className="muted knowledge-tags">知识点：{row.tags.join('、')}</p>}
      </article>;
    })}</div>
  </>;
}
