import Link from 'next/link';
import type { Promotion } from '../../src/domains/promotion';
import { promotionDeadline } from '../_lib/promotion';

export function PromoBar({ promotion }: { promotion: Promotion }) {
  return <div className="promo-bar">
    <div className="container promo-bar-inner">
      <span className="promo-pill">限时免费</span>
      <p>全部题包与原始试卷开放至 <strong>{promotionDeadline(promotion)}</strong>，登录即可练习与下载。</p>
      <Link href="/#courses">挑一套开始 <span aria-hidden="true">→</span></Link>
    </div>
  </div>;
}
