import Link from 'next/link';
import type { ReactNode } from 'react';
import { statusName } from '../_lib/presentation';

export function Book({ size = 22 }: { size?: number }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round"><path d="M12 6.5c-2.6-2-5.5-2.4-9-1.5v13c3.5-.9 6.4-.5 9 1.5 2.6-2 5.5-2.4 9-1.5V5c-3.5-.9-6.4-.5-9 1.5Zm0 0v13M6 9.5c1.1-.1 2.2.1 3 .5m6 0c.8-.4 1.9-.6 3-.5" /></svg>;
}

export function PageTitle({ title, description, back, children }: { title: string; description?: string; back?: [href: string, label: string]; children?: ReactNode }) {
  return <header className="page-title">
    {back && <Link className="back" href={back[0]}><span aria-hidden="true">← </span>{back[1]}</Link>}
    <div className="title-row"><h1>{title}</h1>{children}</div>
    {description && <p>{description}</p>}
  </header>;
}

export function Empty({ children }: { children: ReactNode }) { return <div className="empty">{children}</div>; }
export function Problem({ error }: { error: { code: string; message: string } }) {
  return <p className="notice danger" role="alert">{error.message} <code>{error.code}</code></p>;
}
export function Badge({ children, positive = false }: { children: ReactNode; positive?: boolean }) { return <span className={`badge${positive ? ' positive' : ''}`}>{children}</span>; }
export function Status({ value }: { value: string }) { return <Badge positive={['submitted', 'live', 'credited', 'approved'].includes(value)}>{statusName(value)}</Badge>; }
