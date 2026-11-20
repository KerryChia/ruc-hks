import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '../../../src/db';
import { listCourses, searchPacks } from '../../../src/domains/catalog';
import { searchResourceCourses } from '../../../src/domains/resources';
import { checkRateLimit, rateLimitHeaders } from '../../../src/rate-limit';
import { courseHref, segment } from '../../_lib/presentation';
import { publicProblem } from '../../_lib/web';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const rate = checkRateLimit(request, 'search', 30, 10_000);
  if (!rate.allowed) {
    return NextResponse.json({ code: 'RATE_LIMITED', message: '搜索请求过于频繁，请稍后再试。' }, {
      status: 429,
      headers: { 'Cache-Control': 'no-store', 'Retry-After': String(rate.retryAfter), ...rateLimitHeaders(rate) },
    });
  }
  const query = (request.nextUrl.searchParams.get('q') ?? '').trim().slice(0, 80);
  try {
    const db = await getDb();
    const [courseRows, packRows, resourceRows] = await Promise.all([
      listCourses(db), searchPacks(db, { keyword: query || undefined }), searchResourceCourses(db, query),
    ]);
    const normalized = query.toLowerCase();
    const courses = courseRows.filter(course => course.packCount > 0 && (!normalized || [course.name, course.contributor, ...course.tags].some(value => value.toLowerCase().includes(normalized)))).slice(0, 5);
    const packs = packRows.slice(0, 7);
    const resources = resourceRows.slice(0, 4);
    return NextResponse.json({
      courses: courses.map(course => ({ id: course.id, name: course.name, contributor: course.contributor, href: courseHref(course.slug) })),
      packs: packs.map(pack => ({ id: pack.id, title: pack.title, courseName: pack.courseName, contributor: pack.contributor, itemCount: pack.itemCount, href: `/packs/${segment(pack.id)}` })),
      resources: resources.map(course => ({ id: course.id, name: course.name, contributor: course.contributor, fileCount: course.fileCount, href: `/resources/${course.id}` })),
    }, { headers: { 'Cache-Control': 'no-store', ...rateLimitHeaders(rate) } });
  } catch (error) {
    const problem = publicProblem(error);
    return NextResponse.json(problem, { status: 503 });
  }
}
