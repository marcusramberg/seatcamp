import createIdenticon from './identicon'
import icons from './icons'
import createDropdown from './dropdown'
import localeTime from './locale-time'
import theme from './theme'
import { videoToGif } from './gif'

const MESSAGE_LIMIT = 30
const MAX_RECYCLED = 0

const MESSAGE_HTML = `
  <div class="video-container">
    <video class="message-video" muted loop></video>
    <button class="save shadow-1" title="Save as GIF"></button>
  </div>
  <p>
  <div class="message-meta">
    <div class="dropdown">
      <button class="toggle message-overflow" title="Message options"></button>
      <div class="menu shadow-2">
        <button data-action="mute">Mute user</button>
      </div>
    </div>
    <div class="identicon"></div>
    <time></time>
  </div>`

class Message {
  constructor(owner) {
    this._disposed = false
    this._userId = null
    this._srcUrl = null
    this._isVisible = false
    this._playPauseRequest = null
    this.owner = owner

    this.root = document.createElement('li')
    this.root.innerHTML = MESSAGE_HTML
    this.videoContainer = this.root.querySelector('.video-container')
    this.video = this.root.querySelector('.message-video')
    this.saveButton = this.root.querySelector('.save')
    this.chatText = this.root.querySelector('p')
    this.timestamp = this.root.querySelector('time')
    // placeholder div so it can be replaced with the real thing when bound
    this.identicon = this.root.querySelector('.identicon')
    this.muteButton = this.root.querySelector('.menu button')
    this.messageOverflow = this.root.querySelector('.message-overflow')

    // generate icons where needed
    this.saveButton.appendChild(icons.save('invert'))
    this.messageOverflow.appendChild(icons.moreVert('normal'))

    this.saveButton.addEventListener('click', () => this.saveGif())
    this.dropdown = createDropdown(this.messageOverflow.parentElement, {
      mute: () => this.mute(),
    })
  }

  bind({ key, text, sent, userId, from, video, videoMime, videoType }, myId) {
    this._throwIfDisposed()
    this.unbind()

    const blob = new window.Blob([video], { type: videoMime })
    this._srcUrl = window.URL.createObjectURL(blob)
    this.video.src = this._srcUrl

    this.chatText.innerHTML = text

    const sentDate = new Date(sent)
    this.timestamp.datetime = sentDate.toISOString()
    this.timestamp.innerHTML = localeTime(sentDate)

    if (myId === userId) {
      // No mute menu for yourself
      this.messageOverflow.setAttribute('disabled', true)
    }
    this._userId = userId
    this.refreshIdenticon()

    this._key = key
  }

  refreshIdenticon() {
    const newIdenticon = createIdenticon(this._userId)
    this.identicon.parentElement.replaceChild(newIdenticon, this.identicon)
    this.identicon = newIdenticon
  }

  unbind() {
    this._throwIfDisposed()

    if (this._playPauseRequest) {
      cancelAnimationFrame(this._playPauseRequest)
      this._playPauseRequest = null
    }

    this._userId = null
    this._key = null
    this.dropdown.close()

    this._isVisible = false
    delete this.video.src

    if (this._srcUrl) {
      window.URL.revokeObjectURL(this._srcUrl)
      this._srcUrl = null
    }

    this.messageOverflow.removeAttribute('disabled')
  }

  dispose() {
    this._throwIfDisposed()
    this._disposed = true
  }

  // TODO(tec27): need to fix this for video
  saveGif() {
    this._throwIfDisposed()
    this.saveButton.disabled = true
    this.owner.trackSaveGif()

    videoToGif({ videoElem: this.video, numFrames: 10 })
      .then(gifBlob => {
        this.saveButton.disabled = false
        const url = window.URL.createObjectURL(gifBlob)
        const link = document.createElement('a')
        const click = document.createEvent('MouseEvents')

        link.href = url
        link.download = Date.now() + '.gif'
        click.initMouseEvent(
          'click',
          true,
          true,
          window,
          0,
          0,
          0,
          0,
          0,
          false,
          false,
          false,
          false,
          0,
          null,
        )
        link.dispatchEvent(click)
        setTimeout(() => window.URL.revokeObjectURL(url), 100)
      })
      .catch(err => {
        this.saveButton.disabled = false
        // TODO(tec27): need a good way to display this error to users
        console.error('Error creating GIF:')
        console.dir(err)
        return
      })
  }

  mute() {
    this._throwIfDisposed()
    this.owner.muteUser(this._userId)
  }

  updateVisibility(visible) {
    this._isVisible = visible

    if (!this._playPauseRequest) {
      this._playPauseRequest = requestAnimationFrame(() => {
        this._playPauseRequest = null
        if (this._isVisible) {
          this.video.play()
        } else {
          this.video.pause()
        }
      })
    }
    // TODO(tec27): tell owner about this so it can recycle on scrolling?
  }

  get elem() {
    return this.root
  }

  get userId() {
    return this._userId
  }

  get key() {
    return this._key
  }

  _throwIfDisposed() {
    if (this._disposed) throw new Error('Message already disposed!')
  }
}

class MessageList {
  constructor(listElem, muteSet, tracker) {
    this.elem = listElem
    this.messages = []
    this.messageKeys = new Set()
    this.messageElemsToMessage = new WeakMap()
    this._recycled = []

    this.clientId = ''
    this._mutes = muteSet
    this._tracker = tracker

    theme.on('themeChange', newTheme => this._onThemeChange(newTheme))

    this.intersectionObserver = new IntersectionObserver(entries => {
      for (const { target, isIntersecting } of entries) {
        this.messageElemsToMessage.get(target).updateVisibility(isIntersecting)
      }
    })
  }

  hasMessages() {
    return this.messages.length > 0
  }

  addMessage(chat, removeOverLimit = true) {
    if (this._mutes.has(chat.userId)) {
      return null
    }
    if (this.messageKeys.has(chat.key)) {
      return null
    }

    const newCount = this.messages.length + 1
    if (removeOverLimit && newCount > MESSAGE_LIMIT) {
      const removed = this.messages.splice(0, newCount - MESSAGE_LIMIT)
      this._recycle(removed)
    }

    const message = this._recycled.length ? this._recycled.pop() : new Message(this)
    message.bind(chat, this.clientId)
    this.messages.push(message)
    this.messageKeys.add(message.key)
    this.messageElemsToMessage.set(message.elem, message)
    this.elem.appendChild(message.elem)
    this.intersectionObserver.observe(message.elem)
    return message
  }

  muteUser(userId) {
    if (userId === this.clientId) {
      // don't mute me, me
      return
    }
    this._mutes.add(userId)
    this._tracker.onUserMuted()

    const userMessages = []
    const nonUserMessages = []
    for (const message of this.messages) {
      if (message.userId === userId) {
        userMessages.push(message)
      } else {
        nonUserMessages.push(message)
      }
    }

    this._recycle(userMessages)
    this.messages = nonUserMessages
  }

  trackSaveGif() {
    this._tracker.onSaveGif()
  }

  _recycle(messages) {
    for (const message of messages) {
      this.messageKeys.delete(message.key)
      this.intersectionObserver.unobserve(message.elem)
      this.messageElemsToMessage.delete(message.elem)
      message.elem.parentElement.removeChild(message.elem)
      message.unbind()
    }

    let toRecycle = Math.max(MAX_RECYCLED - this._recycled.length, 0)
    toRecycle = Math.min(toRecycle, messages.length)
    this._recycled = this._recycled.concat(messages.slice(0, toRecycle))
    for (const message of messages.slice(toRecycle, messages.length)) {
      message.dispose()
    }
  }

  _onThemeChange(newTheme) {
    // Re-render identicons based on the new theme to update any inline styles
    for (const message of this.messages) {
      message.refreshIdenticon()
    }
  }
}

export default function createMessageList() {
  return new MessageList(...arguments)
}
