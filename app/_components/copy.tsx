'use client';

import { useRef, useState } from 'react';

export function CopyBlock({ label, text, note, rows = 12 }: { label: string; text: string; note?: string; rows?: number }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      ref.current?.select();
      document.execCommand('copy');
    }
    setCopied(true);
  }
  return <div className="copy-block">
    <div className="copy-block-head"><span>{label}</span><button type="button" onClick={copy}>{copied ? '已复制，直接粘给 Agent' : '一键复制'}</button></div>
    <textarea ref={ref} className="copy-block-text" readOnly rows={rows} value={text} onFocus={event => event.currentTarget.select()} aria-label={label} />
    {note && <small>{note}</small>}
  </div>;
}
