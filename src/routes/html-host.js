// Host script injected into the sandboxed preview iframe. It is a separate
// plain-JS file (imported via `?raw`) so it stays valid JavaScript once
// serialized into the iframe's srcdoc — TypeScript annotations would otherwise
// leak into `toString()`.
function hostLogic() {
  var INLINE = new Set([
    'a', 'abbr', 'b', 'bdi', 'bdo', 'big', 'cite', 'code', 'del', 'dfn',
    'em', 'font', 'i', 'img', 'ins', 'kbd', 'mark', 'q', 'rp', 'rt', 'ruby',
    's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'tt', 'u',
    'var', 'wbr',
  ])
  var SKIP = new Set(['script', 'style', 'template', 'svg', 'math'])
  var XHTML_NS = 'http://www.w3.org/1999/xhtml'

  function collectRuns(root) {
    var runs = []
    var current = []
    function flush() {
      if (current.some(function (t) { return t.data.trim() })) runs.push(current)
      current = []
    }
    function walk(el) {
      for (var i = 0; i < el.childNodes.length; i++) {
        var child = el.childNodes[i]
        if (child.nodeType === 3) {
          current.push(child)
        } else if (child.nodeType === 1) {
          var tag = child.localName
          if (tag === 'br') {
            flush()
          } else if (SKIP.has(tag)) {
            continue
          } else if (INLINE.has(tag)) {
            walk(child)
          } else {
            flush()
            walk(child)
            flush()
          }
        }
      }
    }
    walk(root)
    flush()
    return runs
  }

  function normalize(t) {
    return t.replace(/\s+/g, ' ').trim()
  }
  function runText(run) {
    return normalize(run.map(function (t) { return t.data }).join(''))
  }
  function insertBilingual(run, t) {
    var last = run[run.length - 1]
    var doc = last.ownerDocument
    var parent = last.parentNode
    if (!parent) return null
    var ns = parent.namespaceURI || XHTML_NS
    var br = doc.createElementNS(ns, 'br')
    var span = doc.createElementNS(ns, 'span')
    span.setAttribute('style', 'color: #888;')
    span.textContent = t
    parent.insertBefore(br, last.nextSibling)
    parent.insertBefore(span, br.nextSibling)
    return [br, span]
  }
  function replaceRun(run, t) {
    var target = null
    for (var i = 0; i < run.length; i++) {
      if (run[i].data.trim()) { target = run[i]; break }
    }
    if (!target) target = run[0]
    for (var j = 0; j < run.length; j++) {
      if (run[j] !== target) run[j].data = ''
    }
    if (target) target.data = t
  }

  var base = ''
  var runs = []
  var mode = 'bilingual'
  var inserted = {}
  var translations = {}

  function restore() {
    document.body.innerHTML = base
    runs = collectRuns(document.body)
    inserted = {}
  }
  function removeInserted(i) {
    var pair = inserted[i]
    if (pair) {
      for (var k = 0; k < pair.length; k++) pair[k].remove()
      delete inserted[i]
    }
  }
  function sync(i) {
    removeInserted(i)
    var t = translations[i]
    if (t === undefined || t === '') return
    if (!runs[i]) return
    if (mode === 'bilingual') {
      var created = insertBilingual(runs[i], t)
      if (created) inserted[i] = created
    } else {
      replaceRun(runs[i], t)
    }
  }
  function applyAll() {
    for (var i = 0; i < runs.length; i++) sync(i)
  }

  var heightTimer = null
  function reportHeight() {
    var h = document.body ? document.body.scrollHeight : document.documentElement.scrollHeight
    parent.postMessage({ type: 'height', height: Math.round(h) }, '*')
  }
  function scheduleHeight() {
    if (heightTimer) clearTimeout(heightTimer)
    heightTimer = setTimeout(reportHeight, 80)
  }

  window.addEventListener('resize', scheduleHeight)
  // Images load lazily; remeasure when they arrive (load doesn't bubble,
  // so capture on the document).
  document.addEventListener('load', function (e) {
    if (e.target && e.target.tagName === 'IMG') scheduleHeight()
  }, true)

  window.addEventListener('message', function (e) {
    var data = e.data
    if (!data || typeof data.type !== 'string') return
    if (data.type === 'init') {
      base = data.html
      mode = data.mode || 'bilingual'
      restore()
      parent.postMessage({ type: 'segments', segments: runs.map(runText) }, '*')
      scheduleHeight()
    } else if (data.type === 'translate') {
      var ups = data.updates || []
      for (var i = 0; i < ups.length; i++) translations[ups[i].index] = ups[i].text
      for (var j = 0; j < ups.length; j++) sync(ups[j].index)
      scheduleHeight()
    } else if (data.type === 'mode') {
      mode = data.mode
      restore()
      applyAll()
      scheduleHeight()
    }
  })
}
