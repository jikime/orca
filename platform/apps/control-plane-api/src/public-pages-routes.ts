import type { FastifyInstance, FastifyReply } from 'fastify'

// The Control-Plane-owned public HTTPS surface (doc 16 :11-19, doc 00 :42): the
// result/landing/notice pages a user without the app lands on. Keycloak owns the
// credential-entry flows (email/password, verification token processing, reset
// forms, MFA) — these pages only report outcomes and hand off to the app. R2
// ships the SHELL: correct structure and copy slots, no real token handling.
//
// The desktop app registers the pie:// scheme (src/main), so "continue in app"
// is a deep link. The exact per-flow deep-link path is wired in R3.
const APP_DEEP_LINK = 'pie://auth/callback'

// Public pages are the "Public" data class (doc 24 :26): a strict CSP that allows
// no script at all (default-src 'none') and only same-origin styles. No inline
// script or inline style, so nothing user-supplied can execute here.
const PUBLIC_CSP =
  "default-src 'none'; style-src 'self'; img-src 'self' data:; base-uri 'none'; " +
  "form-action 'none'; frame-ancestors 'none'"

const PUBLIC_CSS = `:root{color-scheme:light dark}
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,sans-serif;margin:0;
  display:flex;min-height:100vh;align-items:center;justify-content:center;
  background:Canvas;color:CanvasText;padding:1.5rem}
main{max-width:28rem;width:100%;text-align:center}
h1{font-size:1.4rem;margin:0 0 .75rem}
p{line-height:1.6;margin:.5rem 0;color:GrayText}
.action{display:inline-block;margin-top:1.25rem;padding:.7rem 1.4rem;
  border-radius:8px;background:Highlight;color:HighlightText;text-decoration:none;
  font-weight:600}
.note{font-size:.85rem;margin-top:1.5rem}`

type PublicPage = {
  route: string
  title: string
  heading: string
  // Result/landing copy slots. Real per-outcome status is injected in R3; the
  // shell shows the neutral "processing" copy so structure and tone are fixed.
  body: string
  // Whether the page offers a "continue in the app" deep link.
  appLink: boolean
}

const PUBLIC_PAGES: PublicPage[] = [
  {
    route: '/public/verify-email',
    title: 'Pie · 이메일 확인',
    heading: '이메일 확인',
    body: '이메일 확인 결과를 표시하는 페이지입니다. 확인이 끝나면 아래에서 앱으로 돌아갈 수 있습니다.',
    appLink: true
  },
  {
    route: '/public/reset-password',
    title: 'Pie · 비밀번호 재설정',
    heading: '비밀번호 재설정 요청',
    body: '비밀번호 재설정 요청 결과를 표시하는 페이지입니다. 실제 재설정은 시스템 브라우저의 인증 화면에서 진행됩니다.',
    appLink: true
  },
  {
    route: '/public/invite',
    title: 'Pie · 초대',
    heading: '초대 확인',
    body: '초대 유효성 확인 결과와 설치본 안내를 표시하는 페이지입니다. 앱이 있으면 아래에서 바로 열 수 있습니다.',
    appLink: true
  },
  {
    route: '/public/sso-callback',
    title: 'Pie · 로그인',
    heading: '로그인 진행',
    body: '외부 SSO 로그인 진행과 콜백 실패 안내를 표시하는 페이지입니다. 이 창은 잠시 후 앱으로 이어집니다.',
    appLink: false
  }
]

function renderPage(page: PublicPage): string {
  const action = page.appLink
    ? `<a class="action" href="${APP_DEEP_LINK}">Pie 앱에서 계속하기</a>`
    : ''
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<title>${page.title}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/public/pie.css">
</head>
<body><main>
<h1>${page.heading}</h1>
<p>${page.body}</p>
${action}
<p class="note">이 페이지에서는 고객·프로젝트·티켓 업무를 처리하지 않습니다.</p>
</main></body></html>`
}

function sendPublic(reply: FastifyReply, contentType: string, payload: string): FastifyReply {
  return reply.header('content-security-policy', PUBLIC_CSP).type(contentType).send(payload)
}

/**
 * Serves the public utility pages statically (no framework, no build step — same
 * discipline as /internal/ops). Registered unconditionally: these pages carry no
 * business data and need no service dependencies. The shell deliberately ignores
 * any query string, so no token is ever read or logged (doc 16 :21-22); R3 wires
 * real token validation with strip-from-URL.
 */
export function registerPublicPagesRoutes(app: FastifyInstance): void {
  app.get('/public/pie.css', async (_request, reply) => sendPublic(reply, 'text/css', PUBLIC_CSS))
  for (const page of PUBLIC_PAGES) {
    const html = renderPage(page)
    app.get(page.route, async (_request, reply) => sendPublic(reply, 'text/html', html))
  }
}

export const PUBLIC_PAGE_ROUTES = PUBLIC_PAGES.map((page) => page.route)
