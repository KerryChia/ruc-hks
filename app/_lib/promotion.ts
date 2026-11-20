import { cache } from 'react';
import { getDb } from '../../src/db';
import { activePromotion, type Promotion } from '../../src/domains/promotion';

// One lookup per request even when the layout, a page and a card all ask for it.
export const currentPromotion = cache(async (): Promise<Promotion | null> => {
  try { return await activePromotion(await getDb()); } catch { return null; }
});

const deadline = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric' });
export const promotionDeadline = (promotion: Promotion) => deadline.format(promotion.endsAt);
