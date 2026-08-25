# ORG-ACCEPTANCE-MATRIX-001 — MOC Production Acceptance Matrix

**Status:** ACTIVE  
**Rule:** no capability is production-ready without evidence for its applicable rows.

| Area | Acceptance requirement | Evidence / test | Launch blocking |
|---|---|---|---|
| Identity | closed signup until onboarding gate | config + API test | yes |
| Identity | valid login does not imply Org role | zero-role dashboard + forbidden action test | yes |
| Identity | first identity can be provisioned without opening signup | Better Auth Admin CLI runbook/test | yes |
| Identity | privileged users enroll MFA | role-assignment/preflight + protected-write test | yes |
| Identity | passkey works on supported browsers | Playwright WebAuthn/emulated authenticator | no for MOC, yes for passkey claim |
| Authorization | every sensitive server action checks permission | authorization matrix integration tests | yes |
| Authorization | scope boundaries prevent IDOR | cross-team/event/case negative tests | yes |
| Authorization | technical admin cannot approve money/read safeguarding by default | role matrix tests | yes |
| Audit | audit rows cannot update/delete | database mutation tests | yes |
| Audit | high-risk action creates audit event | integration tests | yes |
| Applications | intake closed server-side when gate false | API 503 test | yes |
| Applications | same-origin, size, validation, rate limit | adversarial API tests | yes |
| Applications | retry cannot duplicate submission | idempotency integration test | yes |
| Applications | no PII echoed unnecessarily | response snapshot test | yes |
| Applications | bot honeypot silently discards | DB non-insert test | yes |
| Grind | no universal mega-score field/API | schema/API contract test | yes |
| Grind | provenance/confidence/reviewer recorded | integration test | yes |
| Grind | submitter cannot self-verify | DB/API test | yes |
| Grind | corrections preserve history | append/correction test | yes |
| Competition | event rules freeze once live | DB trigger + API test | yes |
| Competition | compliance gate blocks activation | API/domain test | yes |
| Competition | submitter cannot certify own result | DB/API test | yes |
| Competition | certified result correction is append-only | DB/API test | yes |
| Creator | assignment declares work classification | schema/form validation | yes |
| Creator | rights/disclosure refs visible before approval | workflow test | yes when creator program launches |
| Cases | restricted cases invisible without specific role | IDOR/role tests | yes |
| Cases | evidence records immutable provenance/hash | DB/API tests | yes |
| Cases | leadership conflict can require independent review | workflow test | yes |
| Finance | creator/approver/reconciler are separated | DB constraints + API role tests | yes |
| Finance | different currencies never summed as one value | query/UI test | yes |
| Finance | announced prize != funded prize | workflow/state test | yes before prize events |
| Compliance | stale/expired gate blocks applicable activation | domain test | yes |
| Discord | Discord projection failure never corrupts SOT | projection retry test | yes before Discord sync |
| Discord | webhook/bot actions are idempotent | replay test | yes before Discord sync |
| Security | no secrets committed | secret scan | yes |
| Security | CSP has nonce, no production unsafe-inline/eval | response header/browser test | yes |
| Security | HSTS/nosniff/frame/referrer/permissions headers | header assertions | yes |
| Security | dependency high/critical audit green or accepted | CI audit artifact | yes |
| Security | write APIs reject unauthorized cross-origin request | integration tests | yes |
| Security | rate limiting works under concurrency | API load/concurrency test | yes for public intake |
| Security | trusted-edge IP assumption documented/tested | deployment test | yes for public intake |
| Security | sensitive responses use no-store | header tests | yes |
| Security | offboarding revokes sessions/access | end-to-end offboarding test | yes before staffing |
| Recovery | database backup restores successfully | restore drill evidence | yes |
| Recovery | owner/founder absence runbooks exist | 7-day simulation checklist | before scaled operations |
| Mobile | no route depends on hidden desktop-only navigation | 320/360/375/390/412 tests | yes |
| Mobile | 44px minimum actionable target | computed-layout test/manual spot check | yes |
| Mobile | no page-wide horizontal overflow | viewport tests | yes |
| Mobile | iOS safe-area bottom nav usable | mobile Safari project | yes |
| Mobile | form remains usable with virtual-keyboard-sized viewport | reduced-height test | yes |
| Mobile | long names/IDs do not break layout | fixture test | yes |
| Accessibility | skip link and keyboard flow work | keyboard Playwright test | yes |
| Accessibility | focus is visible | screenshot/computed style | yes |
| Accessibility | zoom not disabled | viewport/meta assertion | yes |
| Accessibility | reduced-motion honored | emulation test | yes |
| Accessibility | form labels/errors programmatically associated | DOM/a11y assertions | yes |
| UX | loading, empty, error, permission-denied states exist | route/state matrix | yes |
| UX | all primary nav destinations resolve | route smoke test | yes |
| UX | browser back/forward/deep link works | Playwright navigation test | yes |
| UX | retries do not create duplicate side effects | network retry tests | yes |
| Observability | failures get correlation IDs without PII leakage | log test | yes |
| Deployment | production config fails closed when env missing | build/start config test | yes |
| Deployment | staging/production migrations are controlled | migration workflow | yes |
| Deployment | rollback documented/tested for deploy | runbook + drill | yes |
| Check Up firewall | Org credentials cannot read hidden Check Up data | cross-system auth test | before overlapping operations |

## Browser matrix

Automated Playwright target set:
- Chromium desktop 1440×900
- Firefox desktop 1365×768
- WebKit desktop 1365×768
- Chromium mobile 360×800
- Chromium mobile 390×844
- WebKit iPhone-class 390×844
- Tablet 768×1024
- narrow 320×568 stress viewport
- landscape 844×390 stress viewport

Manual/real-device gate before public launch:
- current iOS Safari
- current Android Chrome
- keyboard-only desktop
- 200% browser zoom
- screen-reader smoke on primary member/application flows

## Adversarial cases

Required negative cases include:
- forged IDs / cross-scope object access
- stale session
- disabled account
- missing 2FA on privileged write
- duplicate submissions / double clicks
- invalid JSON / oversized payload / malformed URLs
- spoofed client IP assumptions
- race on role assignment/payment approval/result certification
- XSS payloads in every free-text field
- SQL metacharacters in every text field
- Unicode/emoji/very long names
- CSRF/cross-origin writes
- replayed Discord events
- event rule edit after live
- result destructive update attempt
- finance self-approval attempt
- restricted-case read as privileged technical admin
- application decision by unauthorized coach
- compliance gate expiry while event is being prepared
- database outage / vendor outage / projection dead-letter
- mobile offline/network interruption during submission

## Definition of evidence

A checkbox, screenshot, or assertion by the implementer alone is not sufficient for high-risk controls. Evidence should be reproducible through automated tests, immutable logs, database constraints, independent review, or an explicit external professional gate as applicable.
