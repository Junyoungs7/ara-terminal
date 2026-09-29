/**
 * 오류 신고 (#206) — 계약: docs/bug-report-api.md
 *   reports.html  : 목록(#) · 상세(#r-…) · 관리(상세 위 [관리자 로그인])
 *   changelog.html: 항목 안의 `(#0012)` 를 그 신고의 상세 링크로 바꾼다
 *
 * 🔴 신고 내용은 아무나 쓴다 — 화면에 넣는 값은 전부 textContent 로. innerHTML 을 쓰지 않는다
 *    (관리자 브라우저에서 스크립트가 돌면 sessionStorage 의 비밀번호가 샌다).
 */
;(function () {
  'use strict'

  // 사이트(8899)와 같은 호스트의 8897. 교차 출처라 서버가 CORS 를 연다.
  var API = location.protocol + '//' + location.hostname + ':8897'
  var PW_KEY = 'ara-reports-admin' // sessionStorage 만 — 탭을 닫으면 사라져야 한다

  /** 문자열 → UTF-8 바이트 → base64. btoa 는 라틴 문자만 받으므로 바이트로 먼저 바꾼다. */
  function b64utf8(s) {
    var bytes = new TextEncoder().encode(s)
    var bin = ''
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
    return btoa(bin)
  }
  var UNREACHABLE = '신고 서버에 닿지 못했습니다.'

  var STATUS = {
    open: '접수',
    investigating: '확인 중',
    fixed: '고침',
    closed: '닫힘',
    wontrepro: '재현 안 됨',
    intended: '의도된 동작',
    duplicate: '중복'
  }

  // ── 조각 ───────────────────────────────────────────────────────────────
  function el(tag, cls, text) {
    var e = document.createElement(tag)
    if (cls) e.className = cls
    if (text != null) e.textContent = String(text)
    return e
  }
  function num(n) {
    return '#' + String(n).padStart(4, '0')
  }
  function day(ms) {
    var d = new Date(ms)
    if (isNaN(d)) return ''
    var p = function (x) {
      return String(x).padStart(2, '0')
    }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
  }
  function stamp(ms) {
    var d = new Date(ms)
    return isNaN(d) ? '' : day(ms) + ' ' + d.toTimeString().slice(0, 5)
  }
  function bytes(n) {
    if (n < 1024) return n + ' B'
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
    return (n / 1024 / 1024).toFixed(1) + ' MB'
  }
  function versionAnchor(v) {
    return 'changelog.html#v' + String(v).replace(/\./g, '-')
  }
  function pw() {
    try {
      return sessionStorage.getItem(PW_KEY) || ''
    } catch (e) {
      return ''
    }
  }

  /**
   * 서버 요청. 실패는 Error(보여 줄 한 문장)로 거절한다.
   *   닿지 못함 → UNREACHABLE · 오류 응답 → 서버의 `error` 문장 그대로
   */
  function api(path, opts) {
    opts = opts || {}
    var headers = {}
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
    // opts.pw: 아직 저장하지 않은 비밀번호로 한 번 묻는다(로그인 확인 — adminBar).
    var key = opts.pw || (opts.admin && pw())
    // UTF-8 → base64 로 싣는다 — 브라우저는 한글 같은 글자를 헤더에 못 싣는다(서버 bearerPassword 주석).
    if (key) headers.Authorization = 'Bearer b64:' + b64utf8(key)
    return fetch(API + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
    }).then(
      function (res) {
        if (res.ok) return opts.raw ? res : res.json()
        return res
          .json()
          .catch(function () {
            return {}
          })
          .then(function (j) {
            throw new Error(j && j.error ? j.error : '서버가 ' + res.status + ' 로 답했습니다.')
          })
      },
      function () {
        throw new Error(UNREACHABLE)
      }
    )
  }

  // ── changelog.html: (#0012) → 상세 링크 ─────────────────────────────────
  var root = document.getElementById('reports')
  if (!root) {
    var re = /\(#(\d{4,})\)/g
    var walker = document.createTreeWalker(document.querySelector('main') || document.body, NodeFilter.SHOW_TEXT)
    var hits = []
    for (var t = walker.nextNode(); t; t = walker.nextNode()) {
      re.lastIndex = 0
      if (re.test(t.nodeValue)) hits.push(t)
    }
    if (!hits.length) return // 적힌 번호가 없으면 서버에 묻지도 않는다
    api('/api/reports').then(function (list) {
      var byNum = {}
      list.forEach(function (r) {
        byNum[r.number] = r.id
      })
      hits.forEach(function (node) {
        var frag = document.createDocumentFragment()
        var s = node.nodeValue
        var last = 0
        s.replace(re, function (m, n, at) {
          var id = byNum[Number(n)]
          if (!id) return m // 목록에 없는 번호는 글자 그대로 둔다
          frag.appendChild(document.createTextNode(s.slice(last, at) + '('))
          var a = el('a', 'link', '#' + n)
          a.href = 'reports.html#' + encodeURIComponent(id)
          frag.appendChild(a)
          frag.appendChild(document.createTextNode(')'))
          last = at + m.length
          return m
        })
        if (!last) return
        frag.appendChild(document.createTextNode(s.slice(last)))
        node.parentNode.replaceChild(frag, node)
      })
    }, function () {
      /* 서버가 꺼져 있으면 번호는 글자로 남는다 — 패치 내역 읽기를 막을 이유가 없다 */
    })
    return
  }

  // ── reports.html ──────────────────────────────────────────────────────
  var filter = 'open' // 기본 [접수] — 하루 한 번 보는 화면
  var blobs = [] // 첨부 blob URL — 화면을 떠날 때 푼다
  var seq = 0 // 늦게 온 응답이 새 화면을 덮지 않게

  function fail(msg) {
    return el('div', 'note danger', msg)
  }
  function clear() {
    blobs.forEach(URL.revokeObjectURL)
    blobs = []
    root.textContent = ''
  }

  function route() {
    var h = location.hash.slice(1)
    try {
      h = decodeURIComponent(h)
    } catch (e) {} // 손으로 친 깨진 %xx — 그대로 두면 서버가 "그런 신고가 없습니다"로 답한다
    if (/^r-/.test(h)) showDetail(h)
    else showList()
  }

  function showList() {
    var my = ++seq
    clear()
    var bar = el('div', 'rp-filter')
    Object.keys(STATUS)
      .map(function (k) {
        return [k, STATUS[k]]
      })
      .concat([['', '전부']])
      .forEach(function (f) {
        var b = el('button', 'chip' + (f[0] === filter ? ' on' : ''), f[1])
        b.type = 'button'
        b.onclick = function () {
          filter = f[0]
          showList()
        }
        bar.appendChild(b)
      })
    root.appendChild(bar)
    var box = el('div', 'muted small', '불러오는 중…')
    root.appendChild(box)

    api('/api/reports' + (filter ? '?status=' + filter : '')).then(
      function (list) {
        if (my !== seq) return
        box.textContent = ''
        box.className = ''
        if (!list.length) {
          box.appendChild(el('p', 'muted', '이 상태의 신고가 없습니다.'))
          return
        }
        var wrap = el('div', 'rp-scroll')
        var tbl = el('table', 'keys rp-list')
        var hr = el('tr')
        ;['#', '제목', '판', '상태', '이름', '날짜', '코멘트'].forEach(function (h) {
          hr.appendChild(el('th', null, h))
        })
        tbl.appendChild(el('thead')).appendChild(hr)
        var tb = tbl.appendChild(el('tbody'))
        list.forEach(function (r) {
          var tr = el('tr')
          tr.appendChild(el('td', 'rp-num', num(r.number)))
          var td = el('td')
          var a = el('a', 'link', r.title)
          a.href = '#' + encodeURIComponent(r.id)
          td.appendChild(a)
          tr.appendChild(td)
          tr.appendChild(el('td', null, r.version || ''))
          tr.appendChild(el('td', null, STATUS[r.status] || r.status))
          tr.appendChild(el('td', null, r.name || '—'))
          tr.appendChild(el('td', null, day(r.createdAt)))
          tr.appendChild(el('td', 'rp-num', r.comments || 0))
          tb.appendChild(tr)
        })
        wrap.appendChild(tbl)
        box.appendChild(wrap)
      },
      function (e) {
        if (my !== seq) return
        box.replaceWith(fail(e.message))
      }
    )
  }

  function showDetail(id) {
    var my = ++seq
    clear()
    var back = el('a', 'link small', '← 목록으로')
    back.href = '#'
    root.appendChild(back)
    root.appendChild(adminBar(id))
    var box = el('div', 'muted small', '불러오는 중…')
    root.appendChild(box)

    api('/api/reports/' + encodeURIComponent(id)).then(
      function (r) {
        if (my !== seq) return
        box.replaceWith(renderDetail(id, r))
      },
      function (e) {
        if (my !== seq) return
        box.replaceWith(fail(e.message))
      }
    )
  }

  // [관리자 로그인] — 서버에 먼저 묻는다(GET /api/admin/check). 맞을 때만 저장한다: 전에는 확인 API 가 없어
  // 틀린 비밀번호도 저장돼 첫 요청이 403 을 받기 전까지 "관리자로 보는 중"이 떴다(R14).
  function adminBar(id) {
    var bar = el('div', 'rp-admin')
    if (pw()) {
      bar.appendChild(el('span', 'muted small', '관리자로 보는 중'))
      var out = el('button', 'btn btn-ghost btn-sm', '로그아웃')
      out.type = 'button'
      out.onclick = function () {
        try {
          sessionStorage.removeItem(PW_KEY)
        } catch (e) {}
        showDetail(id)
      }
      bar.appendChild(out)
      return bar
    }
    var form = el('form', 'rp-row')
    var input = el('input', 'rp-input')
    input.type = 'password'
    input.placeholder = '관리자 비밀번호'
    input.autocomplete = 'current-password'
    var go = el('button', 'btn btn-ghost btn-sm', '관리자 로그인')
    var msg = el('div')
    form.appendChild(input)
    form.appendChild(go)
    form.appendChild(msg)
    form.onsubmit = function (ev) {
      ev.preventDefault()
      if (!input.value) return
      go.disabled = true
      api('/api/admin/check', { pw: input.value }).then(
        function () {
          try {
            sessionStorage.setItem(PW_KEY, input.value)
          } catch (e) {}
          showDetail(id)
        },
        function (e) {
          // 서버 문장 그대로("관리자 비밀번호가 맞지 않습니다." · 닿지 못함) — 저장하지 않는다
          go.disabled = false
          msg.textContent = ''
          msg.appendChild(fail(e.message))
        }
      )
    }
    bar.appendChild(form)
    return bar
  }

  function block(title, text) {
    var s = el('section')
    s.appendChild(el('h3', null, title))
    s.appendChild(el('p', 'rp-text', text || '—'))
    return s
  }

  function renderDetail(id, r) {
    var out = el('div', 'rp-detail')
    var h = el('h2', null, r.title)
    out.appendChild(h)
    var meta = el('p', 'muted small')
    meta.textContent = [num(r.number), STATUS[r.status] || r.status, r.name || '이름 없음', stamp(r.createdAt)]
      .filter(Boolean)
      .join(' · ')
    out.appendChild(meta)

    if (r.fixedIn) {
      var fx = el('p', 'note')
      var a = el('a', 'link', r.fixedIn + ' 에서 고쳤습니다 →')
      a.href = versionAnchor(r.fixedIn)
      fx.appendChild(a)
      out.appendChild(fx)
    }

    out.appendChild(block('무엇을 했나', r.what))
    out.appendChild(block('무엇이 일어났나', r.happened))
    out.appendChild(block('기대', r.expected))

    // 환경 — 값이 객체(sessions)면 `ssh 2 · local 1` 로 편다
    var env = r.env || {}
    var es = el('section')
    es.appendChild(el('h3', null, '환경'))
    var dl = el('dl', 'rp-env')
    Object.keys(env).forEach(function (k) {
      var v = env[k]
      if (v && typeof v === 'object')
        v = Object.keys(v)
          .map(function (x) {
            return x + ' ' + v[x]
          })
          .join(' · ')
      dl.appendChild(el('dt', null, k))
      dl.appendChild(el('dd', null, v))
    })
    es.appendChild(Object.keys(env).length ? dl : el('p', 'muted', '—'))
    out.appendChild(es)

    // 첨부 — 공개 화면엔 이름·크기만. 관리자는 [보기]
    var at = el('section')
    at.appendChild(el('h3', null, '첨부'))
    var files = r.attachments || []
    if (!files.length) at.appendChild(el('p', 'muted', '없음'))
    files.forEach(function (f) {
      var row = el('div', 'rp-file')
      row.appendChild(el('code', null, f.name))
      row.appendChild(el('span', 'muted small', bytes(f.size || 0)))
      if (pw()) {
        var view = el('div', 'rp-view')
        var b = el('button', 'btn btn-ghost btn-sm', '보기')
        b.type = 'button'
        b.onclick = function () {
          b.disabled = true
          showFile(id, f, view).then(null, function (e) {
            b.disabled = false
            view.textContent = ''
            view.appendChild(fail(e.message))
          })
        }
        row.appendChild(b)
        at.appendChild(row)
        at.appendChild(view)
      } else at.appendChild(row)
    })
    out.appendChild(at)

    // 코멘트 타래
    var cs = el('section')
    cs.appendChild(el('h3', null, '코멘트'))
    var cmts = r.comments || []
    if (!cmts.length) cs.appendChild(el('p', 'muted', '아직 없습니다.'))
    cmts.forEach(function (c) {
      var card = el('div', 'card rp-cmt')
      var hd = el('div', 'card-hd', c.author === 'admin' ? '관리자' : '신고자')
      hd.appendChild(el('span', 'g', stamp(c.at)))
      card.appendChild(hd)
      card.appendChild(el('div', 'card-bd rp-text', c.body))
      cs.appendChild(card)
    })
    out.appendChild(cs)

    if (pw()) out.appendChild(adminTools(id, r))
    return out
  }

  // 첨부는 Authorization 헤더가 필요해 <img src> 로 걸 수 없다 → fetch → blob URL
  function showFile(id, f, view) {
    view.textContent = ''
    return api('/api/reports/' + encodeURIComponent(id) + '/files/' + encodeURIComponent(f.name), {
      admin: true,
      raw: true
    })
      .then(function (res) {
        return res.blob()
      })
      .then(function (blob) {
        if (/^image\//.test(f.mime || blob.type)) {
          var u = URL.createObjectURL(blob)
          blobs.push(u)
          var img = el('img', 'rp-img')
          img.alt = f.name
          img.src = u
          view.appendChild(img)
          return
        }
        return blob.text().then(function (s) {
          view.appendChild(el('pre', null, s))
        })
      })
  }

  function adminTools(id, r) {
    var s = el('section', 'rp-tools')
    s.appendChild(el('h3', null, '관리'))
    var msg = el('div')

    var row = el('form', 'rp-row')
    var sel = el('select', 'rp-input')
    Object.keys(STATUS).forEach(function (k) {
      var o = el('option', null, STATUS[k])
      o.value = k
      if (k === r.status) o.selected = true
      sel.appendChild(o)
    })
    var fixed = el('input', 'rp-input')
    fixed.placeholder = '고친 판 (예: 1.0.13)'
    fixed.value = r.fixedIn || ''
    var save = el('button', 'btn btn-primary btn-sm', '저장')
    row.appendChild(sel)
    row.appendChild(fixed)
    row.appendChild(save)
    row.onsubmit = function (ev) {
      ev.preventDefault()
      save.disabled = true
      api('/api/reports/' + encodeURIComponent(id), {
        method: 'PATCH',
        admin: true,
        body: { status: sel.value, fixedIn: fixed.value.trim() || null }
      }).then(
        function () {
          showDetail(id)
        },
        function (e) {
          save.disabled = false
          msg.textContent = ''
          msg.appendChild(fail(e.message))
        }
      )
    }
    s.appendChild(row)

    var cf = el('form', 'rp-cform')
    var ta = el('textarea', 'rp-input')
    ta.rows = 4
    ta.placeholder = '코멘트'
    var send = el('button', 'btn btn-primary btn-sm', '코멘트 달기')
    cf.appendChild(ta)
    cf.appendChild(send)
    cf.onsubmit = function (ev) {
      ev.preventDefault()
      if (!ta.value.trim()) return
      send.disabled = true
      api('/api/reports/' + encodeURIComponent(id) + '/comments', {
        method: 'POST',
        admin: true,
        body: { body: ta.value }
      }).then(
        function () {
          showDetail(id)
        },
        function (e) {
          send.disabled = false
          msg.textContent = ''
          msg.appendChild(fail(e.message))
        }
      )
    }
    s.appendChild(cf)
    s.appendChild(msg)
    return s
  }

  window.addEventListener('hashchange', route)
  route()
})()
