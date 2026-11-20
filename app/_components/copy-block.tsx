'use client';

import { useRef, useState, type ReactNode } from 'react';

export function CopyBlock({ label, value, note, children }: { label: string; value: string; note?: ReactNode; children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const pre = useRef<HTMLPreElement>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const range = document.createRange();
      range.selectNodeContents(pre.current!);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.execCommand('copy');
      selection?.removeAllRanges();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }

  return <div className="copy-block">
    <div className="copy-block-head"><span>{label}</span><button type="button" onClick={copy}>{copied ? '已复制' : '复制'}</button></div>
    <pre ref={pre}>{value}</pre>
    {note && <small>{note}</small>}
    {children}
  </div>;
}
