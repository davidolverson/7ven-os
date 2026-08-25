# ORG-MOC-DAG-001 — Minimum Operational Capability Dependency Graph

**Version:** 1.0.0  
**Governing source:** ORG-SOT-001 v1.0.0 freeze record  
**Rule:** downstream work may prototype early, but it cannot be marked operational until every blocking ancestor is green.

## Dependency graph

```text
G0 SOT FREEZE
│
├─ F0 repository / branch / CI discipline
│  ├─ F1 environments + fail-closed feature gates
│  ├─ F2 PostgreSQL domain schema + migrations
│  └─ F3 security headers / CSP / secrets baseline
│
├─ I0 identity/session
│  ├─ I1 admin bootstrap / closed public signup
│  ├─ I2 TOTP + backup codes + passkeys
│  └─ I3 zero-privilege person provisioning
│
├─ A0 Org RBAC + scoped roles
│  ├─ A1 privileged-auth policy
│  ├─ A2 append-only audit
│  ├─ A3 evidence provenance
│  └─ A4 offboarding/revocation
│
└─ U0 mobile-first application shell + accessibility baseline
   │
   ├─ T0 applications / Free Agent intake
   │  ├─ T1 recruiter queue
   │  ├─ T2 human review + state transitions
   │  ├─ T3 prospect conversion
   │  └─ T4 Grind evidence
   │     ├─ T5 verification/correction/appeal
   │     └─ T6 track progression views
   │
   ├─ C0 teams / roster
   │  ├─ C1 roster history
   │  └─ C2 competition event core
   │     ├─ C3 stages / participants / check-in
   │     ├─ C4 result submission
   │     ├─ C5 independent verify/certify
   │     ├─ C6 append-only corrections
   │     └─ C7 publisher/compliance launch block
   │
   ├─ R0 creator assignments
   │  ├─ R1 work classification
   │  ├─ R2 rights/disclosure references
   │  └─ R3 creator status workflow
   │
   ├─ S0 reporting / case intake
   │  ├─ S1 restricted-case authorization
   │  ├─ S2 evidence chain
   │  ├─ S3 conflict / independent review flags
   │  └─ S4 appeal path
   │
   ├─ B0 payment obligations
   │  ├─ B1 submitter / approver / reconciler separation
   │  ├─ B2 prize allocation + funding state
   │  └─ B3 revenue-definition records
   │
   ├─ P0 external compliance gate registry
   │  ├─ P1 expiry/revalidation
   │  ├─ P2 publisher/title gate
   │  ├─ P3 age/safeguarding gate
   │  ├─ P4 employment/compensation gate
   │  └─ P5 privacy/brand/insurance/legal gates
   │
   ├─ D0 Discord/external identity
   │  ├─ D1 projection outbox/jobs
   │  ├─ D2 retry/dead-letter handling
   │  └─ D3 no Discord-as-SOT invariant
   │
   └─ O0 member/admin CMS surfaces
      ├─ O1 Member Agreement Center baseline
      ├─ O2 dashboard / status / empty / error states
      └─ O3 permission-aware administration

All MOC nodes
  ↓
Q0 unit / type / migration checks
  ↓
Q1 integration / authorization / adversarial API tests
  ↓
Q2 Playwright desktop + mobile + keyboard + accessibility-smoke
  ↓
Q3 security audit / dependency audit / CSP / headers / secrets / IDOR / rate limits
  ↓
Q4 database restore + continuity drill
  ↓
Q5 SENTINEL production reconciliation
  ↓
LAUNCH GATES (still external where applicable)
```

## Priority order

### P0 — cannot be skipped
- frozen SOT/change control
- deterministic dependencies and CI
- environment validation
- durable database/migrations
- identity/session
- RBAC
- privileged auth
- audit immutability
- mobile/accessibility shell
- fail-closed compliance flags

### P1 — first usable organization loop
- application intake
- recruiter review
- prospect conversion
- Grind evidence
- roster management
- basic competition event lifecycle
- creator assignment lifecycle
- case/report intake
- payment-obligation ledger
- admin/member status surfaces

### P2 — production hardening required before public launch
- result verification/certification/correction
- restricted-case isolation
- MFA enforcement for privileged writes
- export/abuse controls
- Discord projection retries/dead-letter
- publisher gate expiration
- backup restore drill
- offboarding test
- mobile/browser regression matrix
- monitoring/incident runbooks

### Deferred by design
These are architected but must not block the MOC unless a specific launch promise depends on them:
- Museum / deep historical visualization
- generalized external SaaS
- advanced Career Center
- deep cross-platform analytics
- large facility/bootcamp operations
- physical-event platform beyond the minimum required safety gates

## Ownership

- **ATLAS:** dependency ordering, change control, evidence registry, no-drift checks
- **FORGE:** implementation, migrations, security controls, tests, deploy/recovery
- **LYRA:** mobile/public/member UX and eventual cleared brand system
- **SIGNAL:** publisher/market/recruitment/sponsor research inputs
- **SENTINEL:** independent adversarial validation and launch gates

No owner self-certifies a high-risk node.
