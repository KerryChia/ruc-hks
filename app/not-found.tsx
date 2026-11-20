import Link from 'next/link';
import { PageTitle } from './_components/ui';

export default function NotFound() {
  return <div className="narrow"><PageTitle title="未找到页面" description="内容可能不存在、已下架，或不属于当前账户。" /><Link href="/" className="button primary">返回课程题库</Link></div>;
}
