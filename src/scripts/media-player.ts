const PLAYER_SELECTOR = '.content .media-video-wrap video'
const COARSE_POINTER = window.matchMedia('(pointer: coarse)').matches

function enhanceVideo(video: HTMLVideoElement) {
  if (video.dataset.enhanced === 'true') {
    return
  }

  const wrap = video.closest('.media-video-wrap')
  if (!(wrap instanceof HTMLElement)) {
    return
  }

  video.dataset.enhanced = 'true'
  video.setAttribute('data-enhanced', '')
  video.setAttribute('playsinline', '')
  video.preload = 'metadata'

  const posterSrc = video.getAttribute('poster') || video.dataset.thumb
  if (posterSrc) {
    const poster = document.createElement('img')
    poster.className = 'media-video-poster'
    poster.src = posterSrc
    poster.alt = ''
    poster.loading = 'lazy'
    poster.decoding = 'async'
    wrap.prepend(poster)
  }

  const hint = document.createElement('div')
  hint.className = 'media-video-hint'
  hint.textContent = COARSE_POINTER ? 'Tap video for controls' : 'Hover video for controls'
  wrap.append(hint)

  let hideTimer: number | undefined

  const showUi = () => {
    wrap.dataset.uiVisible = 'true'
    video.controls = true
    video.removeAttribute('data-ui-hidden')
  }

  const hideUi = () => {
    wrap.removeAttribute('data-ui-visible')
    if (!video.paused && !video.ended) {
      video.controls = false
      video.setAttribute('data-ui-hidden', '')
    }
  }

  const scheduleHide = () => {
    window.clearTimeout(hideTimer)
    const delay = COARSE_POINTER ? 1300 : 1700
    hideTimer = window.setTimeout(hideUi, delay)
  }

  const revealAndMaybeHide = () => {
    showUi()
    if (!video.paused) {
      scheduleHide()
    }
  }

  wrap.addEventListener('pointerenter', () => {
    if (!COARSE_POINTER) {
      revealAndMaybeHide()
    }
  })

  wrap.addEventListener('pointerleave', () => {
    if (!COARSE_POINTER) {
      scheduleHide()
    }
  })

  wrap.addEventListener('focusin', showUi)
  wrap.addEventListener('focusout', scheduleHide)
  video.addEventListener('play', () => {
    wrap.dataset.playing = 'true'
    wrap.dataset.hasPlayed = 'true'
    scheduleHide()
  })
  video.addEventListener('pause', () => {
    wrap.removeAttribute('data-playing')
    showUi()
  })
  video.addEventListener('ended', () => {
    wrap.removeAttribute('data-playing')
    showUi()
  })

  wrap.addEventListener('pointerdown', () => {
    showUi()
    scheduleHide()
  })

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting && !video.paused) {
        video.pause()
      }
    }
  }, { threshold: 0.2 })

  observer.observe(video)
}

function initMediaPlayers() {
  document.querySelectorAll(PLAYER_SELECTOR).forEach((node) => {
    if (node instanceof HTMLVideoElement) {
      enhanceVideo(node)
    }
  })
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initMediaPlayers, { once: true })
}
else {
  initMediaPlayers()
}
