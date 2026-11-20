// Faithful port of the quiz room's rich renderer: code fences, paragraphs, bold,
// inline code, headings, lists, quotes, tables, rules and $…$ math (KaTeX lazy-loaded,
// escaped raw fallback). Everything is HTML-escaped before any tag is added, so the
// output string is safe to inject with dangerouslySetInnerHTML.
const escapeMap: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHTML = (value: string) => String(value).replace(/[&<>"']/g, c => escapeMap[c]);

// Placeholder delimiters around protected spans; the reference uses U+0000, which
// never appears in question text, so spans can never collide with real content.
const NUL = '\x00';

function inlineMD(raw: string) {
  let t = escapeHTML(raw);
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return t;
}

function splitRow(line: string) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
}

function mdBlocks(src: string) {
  const lines = src.split('\n');
  const out: string[] = [];
  let para: string[] = [];
  const flush = () => { if (para.length) { out.push('<p>' + para.map(inlineMD).join('<br>') + '</p>'); para = []; } };
  const protectedSpan = new RegExp('^' + NUL + '[CM]\\d+' + NUL + '$');
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) { flush(); continue; }
    if (protectedSpan.test(t)) { flush(); out.push(t); continue; }
    if (/^(---|\*\*\*|___)$/.test(t)) { flush(); out.push('<hr>'); continue; }
    const heading = t.match(/^(#{1,6})\s+(.*)$/);
    if (heading) { flush(); out.push('<div class="md-h md-h' + Math.min(heading[1].length, 3) + '">' + inlineMD(heading[2]) + '</div>'); continue; }
    if (/^>\s?/.test(t)) { flush(); out.push('<blockquote>' + inlineMD(t.replace(/^>\s?/, '')) + '</blockquote>'); continue; }
    if (/^\|.*\|?\s*$/.test(t) && i + 1 < lines.length && /^\s*\|?[\s:|-]*-[\s:|-]*$/.test(lines[i + 1]) && lines[i + 1].includes('|')) {
      flush();
      const header = splitRow(t);
      i += 1;
      const bodyRows: string[][] = [];
      while (i + 1 < lines.length) {
        const next = lines[i + 1].trim();
        if (next && /^\|/.test(next)) { bodyRows.push(splitRow(next)); i += 1; continue; }
        break;
      }
      out.push('<table><thead><tr>' + header.map(cell => '<th>' + inlineMD(cell) + '</th>').join('')
        + '</tr></thead><tbody>'
        + bodyRows.map(row => '<tr>' + row.map(cell => '<td>' + inlineMD(cell) + '</td>').join('') + '</tr>').join('')
        + '</tbody></table>');
      continue;
    }
    const ulMatch = t.match(/^[-*+]\s+(.*)$/);
    const olMatch = t.match(/^\d+[.、)]\s+(.*)$/);
    if (ulMatch || olMatch) {
      flush();
      const ordered = Boolean(olMatch);
      const itemPattern = ordered ? /^\d+[.、)]\s+/ : /^[-*+]\s+/;
      const items: string[] = [];
      let j = i;
      while (j < lines.length) {
        const line = lines[j].trim();
        if (itemPattern.test(line)) { items.push(line.replace(itemPattern, '')); j++; continue; }
        if (!line && j + 1 < lines.length && itemPattern.test(lines[j + 1].trim())) { j++; continue; }
        break;
      }
      i = j - 1;
      out.push((ordered ? '<ol>' : '<ul>') + items.map(item => '<li>' + inlineMD(item) + '</li>').join('') + (ordered ? '</ol>' : '</ul>'));
      continue;
    }
    para.push(t);
  }
  flush();
  return out.join('');
}

let katexReady = false;
let katexLoading: Promise<boolean> | null = null;

type Katex = { renderToString: (tex: string, options: { displayMode: boolean; throwOnError: boolean }) => string };
function katex(): Katex | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as typeof window & { katex?: Katex }).katex;
}

// Client-only: loads KaTeX from the same CDN the reference site uses.
export function ensureKatex(): Promise<boolean> {
  if (typeof window === 'undefined') return Promise.resolve(false);
  if (katex()) { katexReady = true; return Promise.resolve(true); }
  if (katexLoading) return katexLoading;
  katexLoading = new Promise(resolve => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css';
    document.head.appendChild(link);
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js';
    script.onload = () => { katexReady = true; resolve(true); };
    script.onerror = () => resolve(false);
    document.head.appendChild(script);
  });
  return katexLoading;
}

export const katexIsReady = () => katexReady;
export const richHasMath = (text: string) => /\$[^$\n]+?\$|\\\(|\$\$|\\\[/.test(String(text));

function mathHTML(tex: string, display: boolean) {
  const engine = katex();
  if (katexReady && engine) {
    try { return engine.renderToString(tex, { displayMode: display, throwOnError: false }); }
    catch { /* fall through to the raw placeholder */ }
  }
  return '<code class="math-raw">' + escapeHTML(tex) + '</code>';
}

export function renderRich(source: string) {
  const text = String(source || '');
  const codeSpans: string[] = [];
  let s = text.replace(/```[^\n]*\n([\s\S]*?)```/g, (_, code: string) => {
    codeSpans.push(code);
    return NUL + 'C' + (codeSpans.length - 1) + NUL;
  });
  const mathSpans: [string, boolean][] = [];
  const storeMath = (tex: string, display: boolean) => { mathSpans.push([tex.trim(), display]); return NUL + 'M' + (mathSpans.length - 1) + NUL; };
  s = s.replace(/\$\$([\s\S]+?)\$\$/g, (_, t: string) => storeMath(t, true));
  s = s.replace(/\\\[([\s\S]+?)\\\]/g, (_, t: string) => storeMath(t, true));
  s = s.replace(/\\\(([\s\S]+?)\\\)/g, (_, t: string) => storeMath(t, false));
  s = s.replace(/\$([^$\n]+?)\$/g, (_, t: string) => storeMath(t, false));
  const restore = new RegExp(NUL + '([CM])(\\d+)' + NUL, 'g');
  return mdBlocks(s).replace(restore, (_, kind: string, n: string) => {
    if (kind === 'C') return '<pre><code>' + escapeHTML(codeSpans[Number(n)] ?? '') + '</code></pre>';
    const [tex, display] = mathSpans[Number(n)] ?? ['', false];
    return mathHTML(tex, display);
  });
}
