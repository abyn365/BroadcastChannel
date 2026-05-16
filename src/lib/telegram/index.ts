import type { AnyNode, Cheerio, CheerioAPI } from 'cheerio'
import type { ChannelInfo, EnvCapableAstro, GetChannelInfoParams, Post, Reaction } from '../../types'
import * as cheerio from 'cheerio'
import flourite from 'flourite'
import { LRUCache } from 'lru-cache'
import { $fetch } from 'ofetch'
import { getEnv } from '../env'
import prism from '../prism'
import { isStaticProxyWhitelisted, resolveStaticProxyTarget } from '../static-proxy'

const STYLE_URL_REGEX = /url\((['"]?)(.*?)\1\)/i
const STYLE_DIMENSION_REGEX = {
  width: /width:\s*(\d+(?:\.\d+)?)px/i,
  height: /height:\s*(\d+(?:\.\d+)?)px/i,
} as const
const STYLE_PADDING_TOP_REGEX = /padding-top:\s*(\d+(?:\.\d+)?)%/i
const SYNTHETIC_IMAGE_DIMENSION = 1000
const TITLE_PREVIEW_REGEX = /^.*?(?=[。\n]|http\S)/g
const CONTENT_URL_REGEX = /(url\(["'])((https?:)?\/\/)/g
const UNNECESSARY_HEADERS = new Set(['host', 'cookie', 'origin', 'referer'])

type CacheValue = ChannelInfo | Post
type MessageSelection = Cheerio<AnyNode>
type RequestContext = EnvCapableAstro & { request: Request }

interface StaticProxyOptions {
  staticProxy?: string
}

interface IndexedStaticProxyOptions extends StaticProxyOptions {
  index?: number
}

interface ReplyOptions {
  channel: string
}

interface MessageAssetOptions extends IndexedStaticProxyOptions {
  id?: string
  title?: string
}

interface ExtractPostOptions {
  channel: string
  staticProxy: string
  index?: number
  reactionsEnabled?: string
}

interface LoadedChannelDocument {
  $: CheerioAPI
  channel: string
  staticProxy: string
  reactionsEnabled?: string
}

const cache = new LRUCache<string, CacheValue>({
  ttl: 1000 * 60 * 5,
  maxSize: 50 * 1024 * 1024,
  sizeCalculation: (item: CacheValue) => JSON.stringify(item).length,
})

function cloneCacheValue<T extends CacheValue>(value: T): T {
  return structuredClone(value)
}

function isChannelInfo(value: CacheValue): value is ChannelInfo {
  return 'posts' in value
}

function getRequiredEnv(context: RequestContext, name: string): string {
  const value = getEnv(import.meta.env, context, name)
  if (!value) {
    throw new Error(`Missing required env: ${name}`)
  }
  return value
}

function normalizeEmoji(emoji: string): string {
  const emojiMap: Record<string, string> = {
    '\u2764': '\u2764\uFE0F',
    '\u263A': '\u263A\uFE0F',
    '\u2639': '\u2639\uFE0F',
    '\u2665': '\u2764\uFE0F',
  }

  return emojiMap[emoji] ?? emoji
}

function getCustomEmojiImage(emojiId: string | undefined, staticProxy = ''): string | null {
  if (!emojiId) {
    return null
  }

  const imageUrl = `https://t.me/i/emoji/${emojiId}.webp`
  return `${staticProxy}${imageUrl}`
}

function isNonEmptyString(value: string | null | undefined): value is string {
  return Boolean(value)
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function getImageLoading(index: number): 'eager' | 'lazy' {
  return index > 15 ? 'lazy' : 'eager'
}

function getStyleDimension(style: string | undefined, property: 'width' | 'height'): number | null {
  const value = style?.match(STYLE_DIMENSION_REGEX[property])?.[1]
  return value ? Math.round(Number(value)) : null
}

function getStylePaddingTop(style: string | undefined): number | null {
  const value = style?.match(STYLE_PADDING_TOP_REGEX)?.[1]
  return value ? Number(value) : null
}

function getStyleBackgroundUrl(style: string | undefined): string | null {
  return style?.match(STYLE_URL_REGEX)?.[2] ?? null
}

function hasSelfOrDescendant(element: Cheerio<AnyNode>, selector: string): boolean {
  return element.is(selector) || element.find(selector).length > 0
}

function getMediaSrc(rawUrl: string, staticProxy = ''): string {
  if (!rawUrl) {
    return ''
  }

  if (!staticProxy) {
    return rawUrl
  }

  try {
    const target = resolveStaticProxyTarget(rawUrl)
    return isStaticProxyWhitelisted(target) ? `${staticProxy}${target.toString()}` : target.toString()
  }
  catch {
    return `${staticProxy}${rawUrl}`
  }
}

// Telegram widgets encode image ratios in styles, so this returns synthetic
// dimensions for layout reservation rather than real pixel dimensions.
function inferImageDimensions(
  $: CheerioAPI,
  node: AnyNode,
  fallback = { width: SYNTHETIC_IMAGE_DIMENSION, height: SYNTHETIC_IMAGE_DIMENSION },
): { width: number, height: number } {
  const element = $(node)
  const styles = [
    element.attr('style'),
    element.find('.tgme_widget_message_photo').first().attr('style'),
    element.find('i').attr('style'),
    element.parent().attr('style'),
  ]

  let width: number | null = null
  let height: number | null = null
  let paddingTop: number | null = null

  for (const style of styles) {
    if (width === null) {
      width = getStyleDimension(style, 'width')
    }

    if (height === null) {
      height = getStyleDimension(style, 'height')
    }

    if (paddingTop === null) {
      paddingTop = getStylePaddingTop(style)
    }

    if (width && height) {
      return { width, height }
    }
  }

  // Telegram commonly uses wrap width plus child padding-top to express image
  // ratio instead of returning real pixel dimensions.
  if (paddingTop !== null) {
    const syntheticWidth = width ?? fallback.width
    return {
      width: syntheticWidth,
      height: Math.max(1, Math.round(syntheticWidth * paddingTop / 100)),
    }
  }

  return fallback
}

function getRequestHeaders(request: Request): Record<string, string> {
  const headers = Object.fromEntries(request.headers.entries())

  for (const key of Object.keys(headers)) {
    if (UNNECESSARY_HEADERS.has(key)) {
      delete headers[key]
    }
  }

  return headers
}

async function hydrateTgEmoji($: CheerioAPI, content: MessageSelection, options: StaticProxyOptions = {}): Promise<void> {
  const { staticProxy = '' } = options

  for (const emojiNode of content.find('tg-emoji').toArray()) {
    const emojiId = $(emojiNode).attr('emoji-id')
    const imageUrl = getCustomEmojiImage(emojiId, staticProxy)

    if (imageUrl) {
      $(emojiNode).replaceWith(`<img class="tg-emoji" src="${imageUrl}" alt="" loading="lazy" width="20" height="20" />`)
    }
  }
}

function getVideoStickers($: CheerioAPI, message: MessageSelection, options: IndexedStaticProxyOptions): string {
  const { staticProxy = '', index = 0 } = options
  const fragments: string[] = []
  const loading = getImageLoading(index)

  for (const videoNode of message.find('.js-videosticker_video').toArray()) {
    const videoSrc = $(videoNode).attr('src')
    const imageSrc = $(videoNode).find('img').attr('src')

    fragments.push(`
    <div style="background-image: none; width: 256px;">
      <video src="${videoSrc ? staticProxy + videoSrc : ''}" width="256" height="256" aria-label="Video sticker" preload muted autoplay loop playsinline disablepictureinpicture>
        <img class="sticker" src="${imageSrc ? staticProxy + imageSrc : ''}" alt="Video sticker" width="256" height="256" loading="${loading}" />
      </video>
    </div>
    `)
  }

  return fragments.join('')
}

function getImageStickers($: CheerioAPI, message: MessageSelection, options: IndexedStaticProxyOptions): string {
  const { staticProxy = '', index = 0 } = options
  const fragments: string[] = []
  const loading = getImageLoading(index)

  for (const imageNode of message.find('.tgme_widget_message_sticker').toArray()) {
    const imageSrc = $(imageNode).attr('data-webp')

    fragments.push(
      `<img class="sticker" src="${imageSrc ? staticProxy + imageSrc : ''}" style="width: 256px;" alt="Sticker" width="256" height="256" loading="${loading}" />`,
    )
  }

  return fragments.join('')
}

function getImages($: CheerioAPI, message: MessageSelection, options: MessageAssetOptions): string {
  const { staticProxy = '', id = '', index = 0, title = '' } = options
  const fragments: string[] = []
  const loading = getImageLoading(index)
  const safeTitle = escapeHtmlAttribute(title || 'Image from post')
  const safePreviewLabel = escapeHtmlAttribute(title ? `Open image preview: ${title}` : 'Open image preview')
  const safeCloseLabel = 'Close image preview'

  for (const [photoIndex, photoNode] of message.find('.tgme_widget_message_photo_wrap').toArray().entries()) {
    const imageUrl = $(photoNode).attr('style')?.match(STYLE_URL_REGEX)?.[2]

    if (!imageUrl) {
      continue
    }

    const popoverId = `modal-${id}-${photoIndex}`
    const { width, height } = inferImageDimensions($, photoNode)
    fragments.push(`
      <button
        type="button"
        class="image-preview-button image-preview-wrap"
        popovertarget="${popoverId}"
        popovertargetaction="show"
        aria-label="${safePreviewLabel}"
      >
        <img src="${staticProxy + imageUrl}" alt="${safeTitle}" width="${width}" height="${height}" loading="${loading}" />
      </button>
      <div class="modal" id="${popoverId}" popover aria-label="Image preview">
        <button
          type="button"
          class="modal__backdrop"
          popovertarget="${popoverId}"
          popovertargetaction="hide"
          aria-label="${safeCloseLabel}"
        ></button>
        <button
          type="button"
          class="modal__close"
          popovertarget="${popoverId}"
          popovertargetaction="hide"
          aria-label="${safeCloseLabel}"
        >&times;</button>
        <div class="modal__surface">
          <img class="modal-img" src="${staticProxy + imageUrl}" alt="${safeTitle}" width="${width}" height="${height}" loading="lazy" />
        </div>
      </div>
    `)
  }

  if (!fragments.length) {
    return ''
  }

  const layoutClass = fragments.length % 2 === 0 ? 'image-list-even' : 'image-list-odd'
  return `<div class="image-list-container ${layoutClass}">${fragments.join('')}</div>`
}

// Extract all videos from a message set, returning them individually wrapped for the gallery
function getVideos($: CheerioAPI, message: MessageSelection, options: IndexedStaticProxyOptions): string {
  const { staticProxy = '', index = 0 } = options
  const fragments: string[] = []

  // Collect regular videos — preserve aspect ratio from the wrap's padding-top style
  for (const wrapNode of message.find('.tgme_widget_message_video_wrap').toArray()) {
    const wrap = $(wrapNode)
    const video = wrap.find('video')
    const videoSrc = video.attr('src')
    const posterSrc = getStyleBackgroundUrl(wrap.find('i').attr('style') ?? wrap.attr('style'))

    if (videoSrc) {
      video.attr('src', staticProxy + videoSrc)
    }

    if (posterSrc) {
      video.attr('poster', getMediaSrc(posterSrc, staticProxy))
    }

    video
      .attr('controls', '')
      .attr('preload', index > 15 ? 'metadata' : 'auto')
      .attr('playsinline', '')
      .attr('webkit-playsinline', '')

    // Derive aspect ratio from the Telegram padding-top trick (e.g. padding-top:56.25% → 16/9)
    const paddingTop = getStylePaddingTop(wrap.find('i').attr('style') ?? wrap.attr('style'))
    const aspectStyle = paddingTop ? ` style="aspect-ratio:${(100 / paddingTop).toFixed(4)}"` : ''

    const html = $.html(video)
    if (html) {
      fragments.push(`<div class="media-video-wrap"${aspectStyle}>${html}</div>`)
    }
  }

  // Collect round videos (always 1:1)
  for (const wrapNode of message.find('.tgme_widget_message_roundvideo_wrap').toArray()) {
    const wrap = $(wrapNode)
    const video = wrap.find('video')
    const videoSrc = video.attr('src')
    const posterSrc = getStyleBackgroundUrl(wrap.find('i').attr('style') ?? wrap.attr('style'))

    if (videoSrc) {
      video.attr('src', staticProxy + videoSrc)
    }

    if (posterSrc) {
      video.attr('poster', getMediaSrc(posterSrc, staticProxy))
    }

    video
      .attr('controls', '')
      .attr('preload', index > 15 ? 'metadata' : 'auto')
      .attr('playsinline', '')
      .attr('webkit-playsinline', '')

    const html = $.html(video)
    if (html) {
      fragments.push(`<div class="media-video-wrap" style="aspect-ratio:1">${html}</div>`)
    }
  }

  if (!fragments.length) {
    return ''
  }

  // Single video: just the aspect-ratio wrapper, no grid chrome
  if (fragments.length === 1) {
    return fragments[0]
  }

  // Multiple videos: 2-column grid, first item full-width when count is odd
  const gridClass = fragments.length % 2 === 0 ? 'media-group-even' : 'media-group-odd'
  return `<div class="media-group ${gridClass}">${fragments.map(f => `<div class="media-group__item">${f}</div>`).join('')}</div>`
}

// Legacy single-video getter for backward compat (used in single-post pages)
function getVideo($: CheerioAPI, message: MessageSelection, options: IndexedStaticProxyOptions): string {
  return getVideos($, message, options)
}

function getAudio($: CheerioAPI, message: MessageSelection, options: StaticProxyOptions): string {
  const { staticProxy = '' } = options
  const audio = message.find('.tgme_widget_message_voice')
  const audioSrc = audio.attr('src')

  if (audioSrc) {
    audio.attr('src', staticProxy + audioSrc)
  }

  audio.attr('controls', '')
  return $.html(audio)
}

function getLinkPreview($: CheerioAPI, message: MessageSelection, options: IndexedStaticProxyOptions): string {
  const { staticProxy = '', index = 0 } = options
  const link = message.find('.tgme_widget_message_link_preview')

  if (!link.length) {
    return ''
  }

  const title = message.find('.link_preview_title').text() || message.find('.link_preview_site_name').text()
  const description = message.find('.link_preview_description').text()
  const loading = getImageLoading(index)
  const safeTitle = escapeHtmlAttribute(title || 'Link preview image')

  link.attr('target', '_blank').attr('rel', 'noopener').attr('title', description)

  const image = message.find('.link_preview_image')
  const imageWrap = message.find('.link_preview_image_wrap')

  // Broaden image URL detection: try every possible Telegram preview image pattern
  const previewUrl
    = image.attr('style')?.match(STYLE_URL_REGEX)?.[2]
      || message.find('.link_preview_image_wrap i').attr('style')?.match(STYLE_URL_REGEX)?.[2]
      || message.find('.link_preview_image img').attr('src')
      || imageWrap.find('img').attr('src')
      // Additional patterns used by Telegram for external OG images
      || message.find('.link_preview_thumb').attr('style')?.match(STYLE_URL_REGEX)?.[2]
      || message.find('[class*="link_preview"] img').first().attr('src')
      || message.find('[class*="link_preview"] [style*="background-image"]').first().attr('style')?.match(STYLE_URL_REGEX)?.[2]

  if (previewUrl) {
    const imageSrc = getMediaSrc(previewUrl, staticProxy)
    // Use natural dimensions so CSS controls the layout — avoid fixed 1200/630 attrs
    // that can block the CSS width:100% from taking effect inside flex containers
    const previewImage = `<img class="link_preview_image" alt="${safeTitle}" src="${imageSrc}" loading="${loading}" />`

    // Remove all existing image-related children before prepending the normalized one
    link.find('.link_preview_image, .link_preview_image_wrap, .link_preview_photo, .link_preview_photo_wrap').remove()
    link.prepend(previewImage)
    link.addClass('tgme_widget_message_link_preview--has-image tgme_widget_message_link_preview--image')
  }
  else if (message.find('.link_preview_site_name').length || title || description) {
    link.addClass('tgme_widget_message_link_preview--text')
  }

  return $.html(link)
}

function getReply($: CheerioAPI, message: MessageSelection, options: ReplyOptions): string {
  const { channel } = options
  const reply = message.find('.tgme_widget_message_reply')

  reply.wrapInner('<small></small>').wrapInner('<blockquote></blockquote>')

  const href = reply.attr('href')
  if (href) {
    const replyUrl = new URL(href, 'https://t.me')
    reply.attr('href', replyUrl.pathname.replace(new RegExp(`/${channel}/`, 'i'), '/posts/'))
  }

  return $.html(reply)
}

async function modifyHTMLContent($: CheerioAPI, content: MessageSelection, options: IndexedStaticProxyOptions = {}): Promise<MessageSelection> {
  const { index = 0, staticProxy = '' } = options

  await hydrateTgEmoji($, content, { staticProxy })
  content.find('.emoji').removeAttr('style')

  for (const linkNode of content.find('a').toArray()) {
    const link = $(linkNode)
    link.attr('title', link.text()).removeAttr('onclick')
  }

  for (const [blockquoteIndex, blockquoteNode] of content.find('blockquote[expandable]').toArray().entries()) {
    const innerHTML = $(blockquoteNode).html() ?? ''
    const expandId = `expand-${index}-${blockquoteIndex}`
    const expandContentId = `${expandId}-content`
    const expandable = `<div class="tg-expandable">
      <input type="checkbox" id="${expandId}" class="tg-expandable__checkbox" aria-label="Expand hidden content" aria-controls="${expandContentId}">
      <div id="${expandContentId}" class="tg-expandable__content">${innerHTML}</div>
      <label for="${expandId}" class="tg-expandable__toggle"><span class="sr-only">Expand hidden content</span></label>
    </div>`

    $(blockquoteNode).replaceWith(expandable)
  }

  for (const [spoilerIndex, spoilerNode] of content.find('tg-spoiler').toArray().entries()) {
    const spoiler = $(spoilerNode)
    const spoilerId = `spoiler-${index}-${spoilerIndex}`
    const spoilerInput = `<input type="checkbox" aria-label="Reveal spoiler" aria-controls="${spoilerId}" />`

    spoiler.attr('id', spoilerId).wrap('<label class="spoiler-button"></label>').before(spoilerInput)
  }

  for (const preNode of content.find('pre').toArray()) {
    try {
      const pre = $(preNode)
      pre.find('br').replaceWith('\n')

      const code = pre.text()
      const language = flourite(code, { shiki: true, noUnknown: true }).language || 'text'
      const highlightedCode = prism.highlight(code, prism.languages[language], language)
      pre.html(`<code class="language-${language}">${highlightedCode}</code>`)
    }
    catch (error) {
      console.error(error)
    }
  }

  return content
}

function getReactions($: CheerioAPI, message: MessageSelection, staticProxy: string): Reaction[] {
  const reactions: Reaction[] = []

  for (const reactionNode of message.find('.tgme_widget_message_reactions .tgme_reaction').toArray()) {
    const reaction = $(reactionNode)
    const isPaid = reaction.hasClass('tgme_reaction_paid')
    let emoji = ''
    let emojiId: string | undefined
    let emojiImage: string | undefined

    const standardEmoji = reaction.find('.emoji b')
    if (standardEmoji.length) {
      emoji = normalizeEmoji(standardEmoji.text().trim())
    }

    const tgEmoji = reaction.find('tg-emoji')
    if (tgEmoji.length && !emoji) {
      emojiId = tgEmoji.attr('emoji-id')
      const customEmojiImage = getCustomEmojiImage(emojiId, staticProxy)
      if (customEmojiImage) {
        emojiImage = customEmojiImage
      }
    }

    if (isPaid && !emoji && !emojiImage) {
      emoji = '\u2B50'
    }

    const clone = reaction.clone()
    clone.find('.emoji, tg-emoji, i').remove()
    const count = clone.text().trim()

    if (count) {
      reactions.push({
        emoji,
        emojiId,
        emojiImage,
        count,
        isPaid,
      })
    }
  }

  return reactions
}

// Detect if a message wrap contains a Telegram media group (album):
// multiple .tgme_widget_message siblings all sharing the same post ID prefix
function isMediaGroup($: CheerioAPI, item: AnyNode): boolean {
  const messages = $(item).find('.tgme_widget_message')
  return messages.length > 1
}

// Build a unified content string for a media group (album) inside a single wrap.
// Each sub-message may carry a video, image, or audio; the last one with text
// wins as the caption.
async function extractMediaGroupContent(
  $: CheerioAPI,
  item: AnyNode,
  options: ExtractPostOptions,
): Promise<string> {
  const { staticProxy, index } = options
  const messages = $(item).find('.tgme_widget_message')
  const imageFragments: string[] = []
  const videoFragments: string[] = []
  const audioFragments: string[] = []
  let _captionHtml = ''

  for (const [msgIndex, msgNode] of messages.toArray().entries()) {
    const msg = $(msgNode)
    const msgId = msg.attr('data-post')?.split('/').pop() ?? ''

    // Images in this sub-message
    for (const [photoIndex, photoNode] of msg.find('.tgme_widget_message_photo_wrap').toArray().entries()) {
      const imageUrl = $(photoNode).attr('style')?.match(STYLE_URL_REGEX)?.[2]
      if (!imageUrl)
        continue

      const safeTitle = 'Image from post'
      const safeLabel = 'Open image preview'
      const safeClose = 'Close image preview'
      const popoverId = `modal-album-${msgId}-${photoIndex}`
      const { width, height } = inferImageDimensions($, photoNode)
      const loading = getImageLoading(index ?? 0)

      imageFragments.push(`
        <button
          type="button"
          class="image-preview-button image-preview-wrap"
          popovertarget="${popoverId}"
          popovertargetaction="show"
          aria-label="${safeLabel}"
        >
          <img src="${staticProxy + imageUrl}" alt="${safeTitle}" width="${width}" height="${height}" loading="${loading}" />
        </button>
        <div class="modal" id="${popoverId}" popover aria-label="Image preview">
          <button type="button" class="modal__backdrop" popovertarget="${popoverId}" popovertargetaction="hide" aria-label="${safeClose}"></button>
          <button type="button" class="modal__close" popovertarget="${popoverId}" popovertargetaction="hide" aria-label="${safeClose}">&times;</button>
          <div class="modal__surface">
            <img class="modal-img" src="${staticProxy + imageUrl}" alt="${safeTitle}" width="${width}" height="${height}" loading="lazy" />
          </div>
        </div>
      `)
    }

    // Videos in this sub-message
    for (const wrapNode of msg.find('.tgme_widget_message_video_wrap, .tgme_widget_message_roundvideo_wrap').toArray()) {
      const wrap = $(wrapNode)
      const isRound = wrap.hasClass('tgme_widget_message_roundvideo_wrap')
      const video = wrap.find('video')
      const videoSrc = video.attr('src')
      if (videoSrc) {
        video.attr('src', staticProxy + videoSrc)
      }
      video
        .attr('controls', '')
        .attr('preload', (index ?? 0) > 15 ? 'metadata' : 'auto')
        .attr('playsinline', '')
        .attr('webkit-playsinline', '')

      const paddingTop = isRound ? null : getStylePaddingTop(wrap.find('i').attr('style') ?? wrap.attr('style'))
      const aspectStyle = isRound ? ' style="aspect-ratio:1"' : paddingTop ? ` style="aspect-ratio:${(100 / paddingTop).toFixed(4)}"` : ''

      const html = $.html(video)
      if (html) {
        videoFragments.push(`<div class="media-video-wrap"${aspectStyle}>${html}</div>`)
      }
    }

    // Audio
    const audio = msg.find('.tgme_widget_message_voice')
    if (audio.length) {
      const audioSrc = audio.attr('src')
      if (audioSrc)
        audio.attr('src', staticProxy + audioSrc)
      audio.attr('controls', '')
      const html = $.html(audio)
      if (html)
        audioFragments.push(html)
    }

    // Caption: last sub-message with text wins
    const textSel = msg.find('.tgme_widget_message_text')
    if (textSel.length && textSel.text().trim()) {
      const _modified = await modifyHTMLContent($, textSel, { index: index ?? msgIndex, staticProxy })
      _captionHtml = _modified.html() ?? ''
    }
  }

  const allMedia: string[] = []

  // Images grid
  if (imageFragments.length) {
    const layoutClass = imageFragments.length % 2 === 0 ? 'image-list-even' : 'image-list-odd'
    allMedia.push(`<div class="image-list-container ${layoutClass}">${imageFragments.join('')}</div>`)
  }

  // Videos grid
  if (videoFragments.length === 1) {
    allMedia.push(videoFragments[0])
  }
  else if (videoFragments.length > 1) {
    const gridClass = videoFragments.length % 2 === 0 ? 'media-group-even' : 'media-group-odd'
    allMedia.push(
      `<div class="media-group ${gridClass}">${videoFragments.map(f => `<div class="media-group__item">${f}</div>`).join('')}</div>`,
    )
  }

  // Mixed images+videos: render videos in same grid as images when both present
  // (already handled separately above — each gets its own grid section)

  // Audio
  for (const a of audioFragments) {
    allMedia.push(a)
  }

  if (_captionHtml) {
    allMedia.push(`<div class="media-group__caption">${_captionHtml}</div>`)
  }

  return allMedia.join('')
}

async function extractPost($: CheerioAPI, item: AnyNode | null, options: ExtractPostOptions): Promise<Post> {
  const { channel, staticProxy, index = 0, reactionsEnabled } = options

  // Handle Telegram media group (album) — multiple .tgme_widget_message in one wrap
  if (item && isMediaGroup($, item)) {
    return extractMediaGroupPost($, item, options)
  }

  const message = item ? $(item).find('.tgme_widget_message') : $('.tgme_widget_message')
  const hasReplyText = message.find('.js-message_reply_text').length > 0
  const content = await modifyHTMLContent(
    $,
    message.find(hasReplyText ? '.tgme_widget_message_text.js-message_text' : '.tgme_widget_message_text'),
    { index, staticProxy },
  )
  const contentText = content.text()
  const title = contentText.match(TITLE_PREVIEW_REGEX)?.[0] ?? contentText
  const id = message.attr('data-post')?.replace(new RegExp(`${channel}/`, 'i'), '') ?? ''
  const tags: string[] = []

  for (const tagNode of content.find('a[href^="?q="]').toArray()) {
    const tagLink = $(tagNode)
    const tagText = tagLink.text()

    tagLink.attr('href', `/search/result?q=${encodeURIComponent(tagText)}`)

    const normalizedTag = tagText.replace('#', '')
    if (normalizedTag) {
      tags.push(normalizedTag)
    }
  }

  const messageBody = message.find('.tgme_widget_message_bubble')
  const bubbleChildren = messageBody.children().toArray()
  const textSelector = hasReplyText ? '.tgme_widget_message_text.js-message_text' : '.tgme_widget_message_text'
  const mediaSelector = [
    '.tgme_widget_message_photo_wrap',
    '.tgme_widget_message_video_wrap',
    '.tgme_widget_message_roundvideo_wrap',
    '.tgme_widget_message_voice',
    '.tgme_widget_message_sticker',
    '.js-videosticker_video',
    '.tgme_widget_message_poll',
    '.tgme_widget_message_document_wrap',
    '.tgme_widget_message_video_player.not_supported',
    '.tgme_widget_message_location_wrap',
    '.tgme_widget_message_link_preview',
  ].join(',')

  const textNodeIndex = bubbleChildren.findIndex((node: AnyNode) => hasSelfOrDescendant($(node), textSelector))
  const firstMediaNodeIndex = bubbleChildren.findIndex((node: AnyNode) => hasSelfOrDescendant($(node), mediaSelector))

  const textBeforeMedia
    = textNodeIndex >= 0
      && firstMediaNodeIndex >= 0
      && textNodeIndex < firstMediaNodeIndex

  const mediaContent = [
    getImages($, message, { staticProxy, id, index, title }),
    getVideo($, message, { staticProxy, index }),
    getAudio($, message, { staticProxy }),
    getImageStickers($, message, { staticProxy, index }),
    getVideoStickers($, message, { staticProxy, index }),
    message.find('.tgme_widget_message_poll').html(),
    $.html(message.find('.tgme_widget_message_document_wrap')),
    $.html(message.find('.tgme_widget_message_video_player.not_supported')),
    $.html(message.find('.tgme_widget_message_location_wrap')),
    getLinkPreview($, message, { staticProxy, index }),
  ]
    .filter(isNonEmptyString)
    .join('')

  const contentHtml = [
    getReply($, message, { channel }),
    textBeforeMedia ? content.html() : mediaContent,
    textBeforeMedia ? mediaContent : content.html(),
  ]
    .filter(isNonEmptyString)
    .join('')
    .replace(CONTENT_URL_REGEX, (_match, prefix: string, protocol: string) => {
      const normalizedProtocol = protocol === '//' ? 'https://' : protocol
      return `${prefix}${staticProxy}${normalizedProtocol}`
    })

  return {
    id,
    title,
    type: message.attr('class')?.includes('service_message') ? 'service' : 'text',
    datetime: message.find('.tgme_widget_message_date time').attr('datetime') ?? '',
    tags,
    text: contentText,
    content: contentHtml,
    reactions: reactionsEnabled ? getReactions($, message, staticProxy) : [],
  }
}

// Dedicated extractor for Telegram media group (album) wraps that contain
// multiple .tgme_widget_message siblings under one .tgme_widget_message_wrap.
async function extractMediaGroupPost($: CheerioAPI, item: AnyNode, options: ExtractPostOptions): Promise<Post> {
  const { channel, staticProxy, index = 0, reactionsEnabled } = options
  const messages = $(item).find('.tgme_widget_message')

  // Use the first message for metadata (id, datetime, reactions)
  const firstMessage = messages.first()
  const lastMessage = messages.last()

  const rawId = firstMessage.attr('data-post') ?? lastMessage.attr('data-post') ?? ''
  const id = rawId.replace(new RegExp(`${channel}/`, 'i'), '')
  const datetime = firstMessage.find('.tgme_widget_message_date time').attr('datetime')
    ?? lastMessage.find('.tgme_widget_message_date time').attr('datetime')
    ?? ''

  // Caption = text from the last sub-message that has any
  let captionText = ''
  let _captionHtml = ''
  const tags: string[] = []

  for (const [msgIndex, msgNode] of messages.toArray().entries()) {
    const msg = $(msgNode)
    const textEl = msg.find('.tgme_widget_message_text').first()
    if (textEl.length && textEl.text().trim()) {
      const modified = await modifyHTMLContent($, textEl, { index: index + msgIndex, staticProxy })

      // Collect tags
      for (const tagNode of modified.find('a[href^="?q="]').toArray()) {
        const tagLink = $(tagNode)
        const tagText = tagLink.text()
        tagLink.attr('href', `/search/result?q=${encodeURIComponent(tagText)}`)
        const normalizedTag = tagText.replace('#', '')
        if (normalizedTag && !tags.includes(normalizedTag)) {
          tags.push(normalizedTag)
        }
      }

      captionText = textEl.text()
      _captionHtml = modified.html() ?? ''
    }
  }

  const title = captionText.match(TITLE_PREVIEW_REGEX)?.[0] ?? captionText ?? ''

  // Build the unified media HTML — caption is already appended inside extractMediaGroupContent
  const groupContent = await extractMediaGroupContent($, item, { ...options, index })

  const contentHtml = groupContent
    .replace(CONTENT_URL_REGEX, (_match, prefix: string, protocol: string) => {
      const normalizedProtocol = protocol === '//' ? 'https://' : protocol
      return `${prefix}${staticProxy}${normalizedProtocol}`
    })

  const reactions = reactionsEnabled ? getReactions($, lastMessage, staticProxy) : []

  return {
    id,
    title,
    type: 'text',
    datetime,
    tags,
    text: captionText,
    content: contentHtml,
    reactions,
  }
}

async function loadChannelDocument(
  context: RequestContext,
  params: GetChannelInfoParams & { id?: string } = {},
): Promise<LoadedChannelDocument> {
  const { before, after, q, id } = params
  const host = getEnv(import.meta.env, context, 'TELEGRAM_HOST') ?? 't.me'
  const channel = getRequiredEnv(context, 'CHANNEL')
  const staticProxy = getEnv(import.meta.env, context, 'STATIC_PROXY') ?? '/static/'
  const reactionsEnabled = getEnv(import.meta.env, context, 'REACTIONS')
  const requestUrl = id
    ? `https://${host}/${channel}/${id}?embed=1&mode=tme`
    : `https://${host}/s/${channel}`

  console.info('Fetching', requestUrl, { before, after, q, id })

  const html = await $fetch<string>(requestUrl, {
    headers: getRequestHeaders(context.request),
    query: {
      before: before || undefined,
      after: after || undefined,
      q: q || undefined,
    },
    retry: 3,
    retryDelay: 100,
  })

  return {
    $: cheerio.load(html, {}, false),
    channel,
    staticProxy,
    reactionsEnabled,
  }
}

export async function getChannelPost(context: RequestContext, id: string): Promise<Post> {
  const cacheKey = JSON.stringify({ scope: 'post', id })
  const cachedResult = cache.get(cacheKey)

  if (cachedResult && !isChannelInfo(cachedResult)) {
    console.info('Match Cache', { id })
    return cloneCacheValue(cachedResult)
  }

  const { $, channel, staticProxy, reactionsEnabled } = await loadChannelDocument(context, { id })
  const post = await extractPost($, null, { channel, staticProxy, reactionsEnabled })

  cache.set(cacheKey, post)
  return cloneCacheValue(post)
}

export async function getChannelInfo(context: RequestContext, params: GetChannelInfoParams = {}): Promise<ChannelInfo> {
  const { before = '', after = '', q = '' } = params
  const cacheKey = JSON.stringify({ scope: 'channel', before, after, q })
  const cachedResult = cache.get(cacheKey)

  if (cachedResult && isChannelInfo(cachedResult)) {
    console.info('Match Cache', { before, after, q })
    return cloneCacheValue(cachedResult)
  }

  const { $, channel, staticProxy, reactionsEnabled } = await loadChannelDocument(context, { before, after, q })
  const postNodes = $('.tgme_channel_history .tgme_widget_message_wrap').toArray()
  const posts = (await Promise.all(
    postNodes.map((item: AnyNode, index: number) => extractPost($, item, { channel, staticProxy, index, reactionsEnabled })),
  ))
    .reverse()
    // Keep posts that have an id and either have content or are media groups (content may be
    // empty for caption-less media, but we still render them as a media grid)
    .filter((post: Post) => post.type === 'text' && Boolean(post.id) && Boolean(post.content))

  const channelInfo: ChannelInfo = {
    posts,
    title: $('.tgme_channel_info_header_title').text(),
    description: $('.tgme_channel_info_description').text(),
    descriptionHTML: (await modifyHTMLContent($, $('.tgme_channel_info_description'), { staticProxy })).html(),
    avatar: $('.tgme_page_photo_image img').attr('src'),
  }

  cache.set(cacheKey, channelInfo)
  return cloneCacheValue(channelInfo)
}
