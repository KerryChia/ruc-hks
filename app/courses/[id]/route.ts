import { getDb } from '../../../src/db';
import { getCourse } from '../../../src/domains/catalog';
import { DomainError, uuid } from '../../../src/errors';
import { courseRedirectLocation } from '../../_lib/presentation';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const id = uuid((await params).id);
    const course = await getCourse(await getDb(), id);
    return new Response(null, {
      status: 308,
      headers: { Location: courseRedirectLocation(course.slug, new URL(request.url).search) },
    });
  } catch (error) {
    if (error instanceof DomainError && error.code === 'NOT_FOUND') {
      return new Response(null, { status: 404 });
    }
    throw error;
  }
}
