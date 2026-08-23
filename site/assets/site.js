/**
 * 사이트 동작 — 세 가지뿐이다. 프레임워크 없음, 외부 요청 없음.
 *   1) 배포 정보(release.js)를 화면 곳곳에 채운다
 *   2) 스크롤에 따라 상단 내비를 진하게 하고 섹션을 드러낸다
 *   3) 매뉴얼 목차에 현재 위치를 표시한다
 */
;(function () {
  'use strict'

  var rel = window.ARA_RELEASE || {}

  // 1) 배포 정보 채우기 — data-rel="version" 같은 속성이 붙은 자리에 값을 넣는다.
  document.querySelectorAll('[data-rel]').forEach(function (el) {
    var v = rel[el.getAttribute('data-rel')]
    if (v) el.textContent = v
  })
  // 다운로드 링크는 파일 이름이 버전마다 바뀐다(공백은 URL 인코딩).
  document.querySelectorAll('[data-dl]').forEach(function (a) {
    if (rel.file) a.setAttribute('href', 'downloads/' + encodeURIComponent(rel.file))
  })

  // 2) 내비 배경 — 맨 위에서는 투명, 내려가면 진해진다.
  var nav = document.querySelector('.nav')
  var onScroll = function () {
    if (nav) nav.classList.toggle('scrolled', window.scrollY > 8)
  }
  onScroll()
  window.addEventListener('scroll', onScroll, { passive: true })

  // 등장 애니메이션. IntersectionObserver 가 없거나 모션을 끈 환경에서는 전부 즉시 보인다.
  var reveals = document.querySelectorAll('.reveal')
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (!('IntersectionObserver' in window) || reduced) {
    reveals.forEach(function (el) {
      el.classList.add('in')
    })
  } else {
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (e) {
          if (!e.isIntersecting) return
          e.target.classList.add('in')
          io.unobserve(e.target) // 한 번 나타나면 끝 — 오르내릴 때마다 깜빡이지 않게
        })
      },
      { rootMargin: '0px 0px -12% 0px', threshold: 0.08 }
    )
    reveals.forEach(function (el) {
      io.observe(el)
    })
  }

  // 3) 매뉴얼 목차 — 지금 읽는 절을 표시한다.
  var links = Array.prototype.slice.call(document.querySelectorAll('.toc a[href^="#"]'))
  if (!links.length) return
  var sections = links
    .map(function (a) {
      return document.getElementById(a.getAttribute('href').slice(1))
    })
    .filter(Boolean)

  var mark = function () {
    // 화면 위쪽 1/3 선을 지난 마지막 절이 "현재"다. 스크롤 끝이면 마지막 절을 잡는다.
    var line = window.scrollY + window.innerHeight / 3
    var at = 0
    sections.forEach(function (s, i) {
      if (s.offsetTop <= line) at = i
    })
    if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 4) at = sections.length - 1
    links.forEach(function (a, i) {
      a.classList.toggle('on', i === at)
    })
  }
  mark()
  window.addEventListener('scroll', mark, { passive: true })
  window.addEventListener('resize', mark)
})()
