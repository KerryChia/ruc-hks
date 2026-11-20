import Link from 'next/link';
import { getDb } from '../src/db';
import { listCourses } from '../src/domains/catalog';
import { freeTokenStats } from '../src/domains/ai-gateway';
import { SearchTrigger } from './_components/search';
import { Badge, Empty, Problem } from './_components/ui';
import { currentPromotion, promotionDeadline } from './_lib/promotion';
import { courseHref } from './_lib/presentation';
import { readResult } from './_lib/web';

type CourseItem = Awaited<ReturnType<typeof listCourses>>[number];

function Arrow({ diagonal = false }: { diagonal?: boolean }) {
  return <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{diagonal ? <path d="M6 18 18 6M8 6h10v10" /> : <path d="M5 12h14m-5-5 5 5-5 5" />}</svg>;
}

function CourseCard({ course, index }: { course: CourseItem; index: number }) {
  const sample = course.sampleCount > 0;
  return <Link href={courseHref(course.slug)} className={`course-card tone-${index % 4}`}>
    <span className="course-top"><span className="course-monogram" aria-hidden="true">{sample ? '样' : course.name.slice(0, 1)}</span>{sample && <span className="course-sample-tag">完整样例 · 免费开放</span>}<span className="course-arrow"><Arrow diagonal /></span></span>
    <span className="course-card-copy"><strong>{course.name}</strong><span className="contributor"><span className="contributor-avatar">{course.contributor.slice(0, 1).toUpperCase()}</span>贡献者 · {course.contributor}</span></span>
    <span className="course-bottom"><span>进入课程</span><Arrow /></span>
  </Link>;
}

export default async function Home() {
  const courses = await readResult(async () => listCourses(await getDb()));
  const onlineCourses = courses.ok ? courses.value.filter(course => course.packCount > 0) : [];
  const packCount = onlineCourses.reduce((sum, course) => sum + course.packCount, 0);
  const promotion = await currentPromotion();
  const tokens = await readResult(async () => freeTokenStats(await getDb()));
  return <>
    <section className="hero" aria-labelledby="hero-title">
      <div className="hero-grid-pattern" aria-hidden="true" />
      <div className="hero-copy">
        <span className="eyebrow hero-eyebrow"><span className="pulse-dot" /> {promotion ? `限时免费 · 全部题包开放至 ${promotionDeadline(promotion)}` : '校园练习，与好内容相遇'}</span>
        <h1 id="hero-title">把每一道题，<br />变成<span className="highlight-stroke">进步。</span></h1>
        <p>{promotion ? '活动期间全部题包免费开放，无需授权即可练习、查看解析。' : '精选课程题包，专注作答，即时看见成绩与解析。'}<br className="desktop-only" />{promotion ? '挑一套开始，让这段时间的复习有迹可循。' : '你的下一次突破，就从这里开始。'}</p>
        <SearchTrigger variant="hero" />
        <div className="hero-proof"><span className="proof-avatars"><i>s</i><i>练</i><i>习</i></span><span><strong>{packCount}</strong> 套题包，等待你来挑战</span></div>
      </div>
      <div className="hero-visual" aria-label="练习答题卡示意图">
        <div className="paper-sheet paper-back" aria-hidden="true" />
        <div className="paper-sheet paper-front">
          <div className="paper-head"><span>PRACTICE / 01</span><span className="paper-status"><i /> 作答中</span></div>
          <div className="paper-course"><small>今日练习</small><strong>数据结构 · 基础练习</strong><span>贡献者 sol</span></div>
          <div className="paper-question"><span className="question-index">01</span><div><strong>一棵非空树有 n 个结点，<br />它有几条边？</strong><span className="paper-option">A&nbsp;&nbsp; n 条</span><span className="paper-option selected">B&nbsp;&nbsp; n − 1 条<i>✓</i></span></div></div>
          <div className="paper-progress"><span><i /></span><small>保持节奏，你做得很好</small></div>
        </div>
        <div className="floating-note note-score"><span>本次得分</span><strong>92<small>分</small></strong><i>↗</i></div>
        <div className="floating-note note-contributor"><span className="contributor-avatar">s</span><span>内容由 <strong>sol</strong> 贡献</span></div>
      </div>
    </section>

    <section className="benefit-strip" aria-label="练习特点">
      <div><span className="benefit-number">01</span><span><strong>找到好题</strong><small>按课程发现精选题包</small></span></div>
      <div><span className="benefit-number">02</span><span><strong>专注作答</strong><small>清晰界面，不受干扰</small></span></div>
      <div><span className="benefit-number">03</span><span><strong>看见进步</strong><small>成绩、解析与练习榜单</small></span></div>
    </section>

    {tokens.ok && <section className="token-band" aria-label="免费 token 额度">
      <div className="token-band-copy">
        <span className="eyebrow">FREE TOKENS</span>
        <h2>已提供 {tokens.value.total.toLocaleString('zh-CN')} 免费 token</h2>
        <p>站内 AI 讲评优先从这个额度扣除；额度未用完之前，讲评不扣积分。</p>
      </div>
      <div className="token-band-meter">
        <div><strong>{tokens.value.used.toLocaleString('zh-CN')}</strong><span>已使用</span></div>
        <div><strong>{tokens.value.remaining.toLocaleString('zh-CN')}</strong><span>剩余</span></div>
        <div className="progress-track"><i style={{ width: `${Math.min(100, (tokens.value.used / tokens.value.total) * 100)}%` }} /></div>
      </div>
    </section>}

    <section id="courses" className="section courses-section" aria-labelledby="courses-title">
      <div className="section-heading"><div><span className="eyebrow">EXPLORE COURSES</span><h2 id="courses-title">选一门课，现在开始</h2><p>从贡献者分享的练习中，找到你的下一步。</p></div>
        {courses.ok && <Badge>{onlineCourses.length} 门课程</Badge>}
        <Link className="button secondary" href="/courses">全部题库 <Arrow /></Link>
      </div>
      {!courses.ok ? <Problem error={courses.error} /> : onlineCourses.length === 0 ? <Empty>暂无已发布的在线练习。</Empty> :
        <div className="course-grid">{onlineCourses.map((course, index) => <CourseCard key={course.id} course={course} index={index} />)}</div>}
    </section>

    <section className="contribute-banner">
      <div><span className="eyebrow">SHARE WHAT YOU KNOW</span><h2>好题，值得被更多人看见。</h2><p>分享你的原创练习，让知识在每一次作答中继续生长。</p></div>
      <Link href="/upload" className="button light">贡献题包 <Arrow diagonal /></Link>
    </section>
  </>;
}
