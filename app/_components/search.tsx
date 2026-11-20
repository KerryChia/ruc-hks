'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

type CourseResult = { id: string; name: string; href: string; contributor: string };
type PackResult = { id: string; title: string; href: string; courseName: string; contributor: string; itemCount: number };
type ResourceResult = { id: string; name: string; href: string; contributor: string; fileCount: number };
type Results = { courses: CourseResult[]; packs: PackResult[]; resources: ResourceResult[] };
type SearchContextValue = { open: () => void };

const SearchContext = createContext<SearchContextValue | null>(null);
const emptyResults: Results = { courses: [], packs: [], resources: [] };

function SearchIcon({ size = 20 }: { size?: number }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 4 4" /></svg>;
}

function ArrowIcon() {
  return <svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14m-5-5 5 5-5 5" /></svg>;
}

function Highlight({ text, query }: { text: string; query: string }) {
  const keyword = query.trim();
  const index = keyword ? text.toLowerCase().indexOf(keyword.toLowerCase()) : -1;
  if (index < 0) return <>{text}</>;
  return <>{text.slice(0, index)}<mark>{text.slice(index, index + keyword.length)}</mark>{text.slice(index + keyword.length)}</>;
}

export function SearchTrigger({ variant = 'nav', className = '' }: { variant?: 'nav' | 'hero' | 'icon'; className?: string }) {
  const context = useContext(SearchContext);
  if (!context) return null;
  if (variant === 'icon') return <button className={`icon-button ${className}`} type="button" onClick={context.open} aria-label="搜索课程、题包和资料"><SearchIcon /></button>;
  return <button className={`search-trigger search-trigger-${variant} ${className}`} type="button" onClick={context.open}>
    <SearchIcon size={variant === 'hero' ? 22 : 18} />
    <span>{variant === 'hero' ? '搜索课程、题包或资料，马上开始学习' : '搜索课程、题包、资料…'}</span>
    {variant === 'nav' && <kbd>Ctrl K</kbd>}
    {variant === 'hero' && <span className="search-go"><ArrowIcon /></span>}
  </button>;
}

export function SearchProvider({ children }: { children: ReactNode }) {
  const [visible, setVisible] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Results>(emptyResults);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const pathname = usePathname();
  const open = useCallback(() => setVisible(true), []);
  const close = useCallback(() => setVisible(false), []);

  useEffect(() => { close(); }, [pathname, close]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setVisible(value => !value);
      }
      if (event.key === 'Escape') setVisible(false);
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);

  useEffect(() => {
    if (!visible) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const timer = window.setTimeout(() => inputRef.current?.focus(), 80);
    return () => { document.body.style.overflow = previous; window.clearTimeout(timer); };
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(query.trim())}`, { signal: controller.signal });
        if (!response.ok) throw new Error('search unavailable');
        const data = await response.json() as Results;
        setResults(data);
        setUnavailable(false);
        setActive(0);
      } catch (error) {
        if (!controller.signal.aborted) { setResults(emptyResults); setUnavailable(true); }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, query ? 180 : 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query, visible]);

  const packStart = results.courses.length;
  const resourceStart = packStart + results.packs.length;
  const items = useMemo(() => [
    ...results.courses.map(item => ({ ...item, kind: 'course' as const, title: item.name, detail: `贡献者 ${item.contributor}` })),
    ...results.packs.map(item => ({ ...item, kind: 'pack' as const, detail: `${item.courseName} · ${item.itemCount} 道题 · ${item.contributor}` })),
    ...results.resources.map(item => ({ ...item, kind: 'resource' as const, title: item.name, detail: `${item.fileCount} 份资料 · ${item.contributor}` })),
  ], [results]);

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive(value => Math.min(value + 1, Math.max(0, items.length - 1)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive(value => Math.max(0, value - 1));
    } else if (event.key === 'Enter' && items[active]) {
      event.preventDefault();
      window.location.href = items[active].href;
    }
  };

  useEffect(() => {
    document.getElementById(`search-result-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  return <SearchContext.Provider value={{ open }}>
    {children}
    {visible && <div className="search-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
      <section className="search-dialog" role="dialog" aria-modal="true" aria-label="全站搜索">
        <div className="search-input-wrap"><SearchIcon size={23} />
          <input ref={inputRef} value={query} onChange={event => setQuery(event.target.value)} onKeyDown={onInputKeyDown} placeholder="输入课程、题包或资料名称…" aria-label="搜索课程、题包和资料" autoComplete="off" />
          {loading && <span className="search-spinner" aria-label="搜索中" />}
          <button className="search-close" type="button" onClick={close} aria-label="关闭搜索">Esc</button>
        </div>
        <div className="search-results" aria-live="polite">
          <div className="search-results-label">{query.trim() ? `“${query.trim()}” 的搜索结果` : '快速前往'}</div>
          {items.length === 0 && !loading ? <div className="search-empty">
            <span className="search-empty-icon"><SearchIcon size={28} /></span>
            <h3>{unavailable ? '搜索暂时不可用' : query.trim() ? '暂时没有找到相关内容' : '开始输入，发现你的下一份练习'}</h3>
            <p>{unavailable ? '请稍后重试，或直接浏览全部课程。' : query.trim() ? '试试更短的关键词，或浏览全部课程。' : '可以搜索“数据结构”“概率论”、题包或贡献者。'}</p>
            <Link href="/#courses" className="button secondary" onClick={close}>浏览全部课程</Link>
          </div> : <>
            {results.courses.length > 0 && <div className="result-group-title">课程</div>}
            {items.map((item, index) => <div key={`${item.kind}-${item.id}`}>
              {index === packStart && results.packs.length > 0 && <div className="result-group-title">题包</div>}
              {index === resourceStart && results.resources.length > 0 && <div className="result-group-title">课程资料</div>}
              <Link id={`search-result-${index}`} href={item.href} onClick={close} className={`search-result${index === active ? ' active' : ''}`} onMouseEnter={() => setActive(index)}>
                <span className={`search-result-icon ${item.kind}`}>{item.kind === 'course' ? '课' : item.kind === 'pack' ? '练' : '资'}</span>
                <span className="search-result-copy"><strong><Highlight text={item.title} query={query} /></strong><small>{item.detail}</small></span>
                <ArrowIcon />
              </Link>
            </div>)}
          </>}
        </div>
        <footer className="search-footer"><span><kbd>↑</kbd><kbd>↓</kbd> 选择</span><span><kbd>↵</kbd> 打开</span><span>搜索课程、题包与课程资料</span></footer>
      </section>
    </div>}
  </SearchContext.Provider>;
}
