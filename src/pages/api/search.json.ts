import type { APIRoute } from 'astro'
import { getChannelInfo } from '../../lib/telegram'

const MIN_QUERY_LENGTH = 1
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 40

export const GET: APIRoute = async (context) => {
  const query = context.url.searchParams.get('q')?.trim() ?? ''
  const limitParam = Number(context.url.searchParams.get('limit') ?? DEFAULT_LIMIT)
  const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(MAX_LIMIT, Math.floor(limitParam))) : DEFAULT_LIMIT

  if (query.length < MIN_QUERY_LENGTH) {
    return Response.json({
      query,
      posts: [],
    })
  }

  const channel = await getChannelInfo(context, { q: query })
  const posts = (channel.posts ?? []).slice(0, limit).map(post => ({
    id: post.id,
    title: post.title,
    datetime: post.datetime,
    text: post.text,
    tags: post.tags,
  }))

  return Response.json({
    query,
    posts,
  })
}
