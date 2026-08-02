const { style } = require('bare-tui')

// Tron palette: a black grid lit by cyan circuitry, with amber reserved for anything the operator
// should actually look at. Everything is 256-colour so it renders the same in any modern terminal.
const C = {
  glow: '51', // hot cyan — active edges, selection
  line: '37', // circuit cyan — borders, rules
  dim: '24', // deep blue — inactive structure
  text: '195', // pale cyan-white — body text
  mute: '66', // desaturated — secondary text
  amber: '214', // CLU orange — commands, prompts
  hot: '208', // deeper orange — warnings
  good: '48', // derezz green — healthy
  dead: '240' // offline
}

const fg = (c) => (s) => style().foreground(c).render(s)
const paint = {
  glow: fg(C.glow),
  line: fg(C.line),
  dim: fg(C.dim),
  text: fg(C.text),
  mute: fg(C.mute),
  amber: fg(C.amber),
  hot: fg(C.hot),
  good: fg(C.good),
  dead: fg(C.dead),
  bold: (s) => style().bold().foreground(C.glow).render(s),
  sel: (s) => style().background('23').foreground(C.glow).bold().render(s)
}

const vis = (s) => style.width(String(s))

function pad (s, n) {
  const w = vis(s)
  return w >= n ? clip(s, n) : s + ' '.repeat(n - w)
}

// Truncate on VISIBLE width. Delegated to bare-tui because it parses escape sequences as units and
// re-emits the reset — walking the string character by character counts every byte of an ANSI
// sequence as a visible cell and cuts the line to a fraction of its real width.
function clip (s, n) {
  s = String(s)
  if (vis(s) <= n) return s
  return style.truncate(s, Math.max(1, n - 1)) + '…'
}

// Letter-spaced caps — the panel labels etched into the circuit board.
const etch = (s) => s.toUpperCase().split('').join(' ')

// A titled panel. Drawn by hand rather than with style().border() so the label can sit inside the
// top edge, which is most of the look.
function panel (title, lines, w, opts = {}) {
  const colour = opts.colour || C.line
  const inner = w - 2
  const edge = (s) => style().foreground(colour).render(s)

  // ┌ ─ <label> ─… ┐  — total visible width must be exactly w, or the corners drift off the bottom.
  const label = title ? '┤ ' + etch(title) + ' ├' : ''
  const top = edge('┌─') +
    (title ? style().foreground(opts.titleColour || C.glow).bold().render(label) : '') +
    edge('─'.repeat(Math.max(0, inner - 1 - vis(label))) + '┐')

  const body = lines.map((l) => edge('│') + ' ' + pad(l, inner - 2) + ' ' + edge('│'))
  const bottom = edge('└' + '─'.repeat(inner) + '┘')

  return [top, ...body, bottom].join('\n')
}

// Fill a panel to an exact height so the layout never jumps as rows come and go.
function fill (lines, n) {
  const out = lines.slice(0, n)
  while (out.length < n) out.push('')
  return out
}

module.exports = { C, paint, panel, pad, clip, vis, etch, fill }
