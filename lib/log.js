const path = require('bare-path')
const FileLog = require('bare-file-logger')

// What an operator reads and what a developer reads are not the same thing. The console owns the
// terminal, so a stack has nowhere on screen to go — and over a live game it must not appear at all.
// Short lines go to the ring the TUI draws; the whole fault goes to the file, next to the identity
// it belongs to.
const MAX_LINES = 300
const MAX_BYTES = 1024 * 1024

class Log {
  constructor(dir, opts = {}) {
    this.lines = []
    this.onLine = opts.onLine || (() => {})
    this.file = new FileLog(path.join(dir, 'mcp.log'), {
      maxSize: MAX_BYTES,
      rotate: (file) => file + '.1'
    })
  }

  line(text) {
    this.lines.push(text)
    if (this.lines.length > MAX_LINES) this.lines.shift()
    this.file.info('%s', text)
    this.onLine(text)
  }

  // One line an operator can act on, and everything a developer needs, in two different places.
  fault(what, err) {
    this.line(what + ' failed — ' + (err.message || err))
    this.file.info('%s\n%s', what, err.stack || String(err))
  }
}

module.exports = { Log }
