// src/pages/rss.xml.ts
// CHANGES: Added media enclosure support, OG image injection, richer media in RSS content

import type { APIRoute, APIContext  } from 'astro'
import rss from '@astrojs/rss'
import sanitizeHtml from 'sanitize-html'
import { getEnv } from '../lib/env'
import { getChannelInfo } from '../lib/telegram'

/**
 * Extract the first image URL from HTML content for use as an enclosure.
 */
function extractFirstImageUrl(html: string): string | null {
  const match = html.match(/<img[^>]+src="([^"]+)"/)
  return match?.[1] ?? null
}

/**
 * Extract all image URLs from HTML content.
 */
function extractAllImageUrls(html: string): string[] {
  const urls: string[] = []
  const re = /<img[^>]+src="([^"]+)"/g
  let m: RegExpExecArray | null
  // eslint-disable-next-line no-cond-assign
  while ((m = re.exec(html)) !== null) {
    if (m[1] && !m[1].includes('modal-img')) {
      urls.push(m[1])
    }
  }
  return urls
}

/**
 * Extract audio src from content (native-audio-player).
 */
function extractAudioSrc(html: string): string | null {
  const match = html.match(/data-audio-src="([^"]+)"/)
  return match?.[1] ?? null
}

/**
 * Extract video src from content.
 */
function extractVideoSrc(html: string): string | null {
  const match = html.match(/<video[^>]+src="([^"]+)"/)
  return match?.[1] ?? null
}

/**
 * Build a media-rich RSS content block that prefixes the raw HTML with
 * an OG thumbnail + media enclosure hints so RSS readers can display
 * the media inline.
 */
function buildRssContent(html: string, siteUrl: string): string {
  const sanitized = sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'video', 'audio', 'source', 'figure', 'figcaption']),
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      video:  ['src', 'width', 'height', 'poster', 'controls', 'preload'],
      audio:  ['src', 'controls', 'preload'],
      source: ['src', 'type'],
      img:    ['src', 'srcset', 'alt', 'title', 'width', 'height', 'loading', 'class'],
      figure: [],
      figcaption: [],
    },
    exclusiveFilter(frame) {
      // Remove modal duplicate images and audio player internals
      return (
        (frame.tag === 'img' && frame.attribs.class?.includes('modal-img')) ||
        (frame.tag === 'div' && frame.attribs.class?.includes('nap__'))
      )
    },
  })

  // Replace native-audio-player divs with a simple <audio> for RSS readers
  const rssHtml = sanitized.replace(
    /<div[^>]*class="[^"]*native-audio-player[^"]*"[^>]*data-audio-src="([^"]+)"[^>]*>[\s\S]*?<\/div>/gi,
    (_match, src) => `<audio controls src="${src}" style="width:100%;margin:8px 0"></audio>`,
  )

  return rssHtml
}

export const GET: APIRoute = async (context: APIContext) => {
  const { SITE_URL } = context.locals
  const tag = context.url.searchParams.get('tag')
  const channel = await getChannelInfo(context, {
    q: tag ? `#${tag}` : '',
  })
  const posts = channel.posts ?? []
  const requestUrl = new URL(context.request.url)

  requestUrl.pathname = SITE_URL
  requestUrl.search = ''

  const siteUrl = requestUrl.toString()

  const response = await rss({
    title: `${tag ? `${tag} | ` : ''}${channel.title}`,
    description: channel.description,
    site: requestUrl.origin,
    trailingSlash: false,
    stylesheet: getEnv(import.meta.env, context, 'RSS_BEAUTIFY') ? '/rss.xsl' : undefined,
    customData: channel.avatar
      ? `<image><url>${channel.avatar}</url><title>${channel.title}</title><link>${siteUrl}</link></image>`
      : undefined,
    items: posts.map((item) => {
      const contentHtml = item.content
      const imageUrls   = extractAllImageUrls(contentHtml)
      const audioSrc    = extractAudioSrc(contentHtml)
      const videoSrc    = extractVideoSrc(contentHtml)
      const firstImage  = imageUrls[0] ?? null

      // Build enclosures for media-rich posts
      const enclosures: Array<{ url: string; length: number; type: string }> = []

      if (firstImage) {
        enclosures.push({ url: firstImage, length: 0, type: 'image/jpeg' })
      }
      if (audioSrc) {
        enclosures.push({ url: audioSrc, length: 0, type: 'audio/mpeg' })
      }
      if (videoSrc && !audioSrc) {
        enclosures.push({ url: videoSrc, length: 0, type: 'video/mp4' })
      }

      // Build media:content namespace entries for richer RSS readers
      const mediaContent = [
        ...imageUrls.slice(0, 4).map(
          (url) => `<media:content url="${url}" medium="image" />`,
        ),
        audioSrc ? `<media:content url="${audioSrc}" medium="audio" />` : '',
        videoSrc ? `<media:content url="${videoSrc}" medium="video" />` : '',
      ].filter(Boolean).join('\n')

      return {
        link: `posts/${item.id}`,
        title: item.title,
        description: item.description,
        pubDate: new Date(item.datetime),
        enclosure: enclosures[0], // RSS 2.0 supports one enclosure per item
        customData: mediaContent
          ? `${mediaContent}${firstImage ? `\n<media:thumbnail url="${firstImage}" />` : ''}`
          : undefined,
        content: buildRssContent(contentHtml, siteUrl),
      }
    }),
  })

  // Add media namespace declaration to the root <rss> element
  let xmlText = await response.text()
  xmlText = xmlText.replace(
    '<rss',
    '<rss xmlns:media="http://search.yahoo.com/mrss/" xmlns:dc="http://purl.org/dc/elements/1.1/"',
  )

  return new Response(xmlText, {
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  })
}