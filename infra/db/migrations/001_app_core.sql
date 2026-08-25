BEGIN;

CREATE SCHEMA IF NOT EXISTS app;

CREATE TABLE IF NOT EXISTS app.person_profile (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id text UNIQUE NOT NULL,
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 80),
  public_handle text CHECK (public_handle IS NULL OR char_length(public_handle) BETWEEN 1 AND 64),
  membership_status text NOT NULL DEFAULT 'community' CHECK (membership_status IN (
    'community','applicant','prospect','ascendant','member','pantheon','alumni','legacy','inactive'
  )),
  age_band text NOT NULL DEFAULT 'unknown' CHECK (age_band IN (
    'unknown','under_13','13_15','16_17','18_plus'
  )),
  age_verified_at timestamptz,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.person_track (
  person_id uuid NOT NULL REFERENCES app.person_profile(id) ON DELETE CASCADE,
  track text NOT NULL CHECK (track IN ('competitive','creator','builder','community','leadership')),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','paused','completed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  PRIMARY KEY (person_id, track)
);

CREATE TABLE IF NOT EXISTS app.relationship_classification (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL REFERENCES app.person_profile(id) ON DELETE RESTRICT,
  relationship_type text NOT NULL CHECK (relationship_type IN (
    'community_participant','volunteer','prize_competitor','employee','independent_contractor',
    'creator_partner','sponsored_talent','advisor','vendor'
  )),
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  evidence_ref text,
  external_review_required boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE TABLE IF NOT EXISTS app.role_assignment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL REFERENCES app.person_profile(id) ON DELETE CASCADE,
  role_key text NOT NULL CHECK (role_key IN (
    'member','recruiter','coach','creator_manager','competition_admin','integrity_officer',
    'safeguarding_officer','finance_submitter','finance_approver','finance_reconciler',
    'council','privileged_admin','break_glass'
  )),
  scope_type text NOT NULL DEFAULT 'organization' CHECK (scope_type IN ('organization','title','team','event','case','finance')),
  scope_id uuid,
  granted_by uuid REFERENCES app.person_profile(id) ON DELETE SET NULL,
  reason text NOT NULL,
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS role_assignment_person_idx ON app.role_assignment(person_id, role_key);
CREATE INDEX IF NOT EXISTS role_assignment_scope_idx ON app.role_assignment(scope_type, scope_id);

CREATE TABLE IF NOT EXISTS app.application (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid REFERENCES app.person_profile(id) ON DELETE SET NULL,
  email text NOT NULL,
  display_name text NOT NULL,
  requested_track text NOT NULL CHECK (requested_track IN ('competitive','creator','builder','community','leadership')),
  game_title text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  state text NOT NULL DEFAULT 'submitted' CHECK (state IN (
    'draft','submitted','screening','scouted','trial','evaluation','development','roster_candidate','accepted','declined','withdrawn'
  )),
  privacy_notice_version text NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES app.person_profile(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS application_state_idx ON app.application(state, requested_track, submitted_at DESC);

CREATE TABLE IF NOT EXISTS app.grind_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL REFERENCES app.person_profile(id) ON DELETE CASCADE,
  track text NOT NULL CHECK (track IN ('competitive','creator','builder','community','leadership')),
  evidence_type text NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('competition','discord','stream','social','staff_review','project','manual','other')),
  source_ref text,
  description text NOT NULL,
  confidence numeric(4,3) NOT NULL DEFAULT 1 CHECK (confidence >= 0 AND confidence <= 1),
  max_influence smallint NOT NULL DEFAULT 1 CHECK (max_influence BETWEEN 0 AND 100),
  occurred_at timestamptz NOT NULL,
  submitted_by uuid REFERENCES app.person_profile(id) ON DELETE SET NULL,
  verified_by uuid REFERENCES app.person_profile(id) ON DELETE SET NULL,
  verification_state text NOT NULL DEFAULT 'pending' CHECK (verification_state IN ('pending','verified','rejected','corrected')),
  correction_of uuid REFERENCES app.grind_evidence(id) ON DELETE RESTRICT,
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (verified_by IS NULL OR submitted_by IS NULL OR verified_by <> submitted_by)
);

CREATE INDEX IF NOT EXISTS grind_evidence_person_idx ON app.grind_evidence(person_id, track, occurred_at DESC);

CREATE TABLE IF NOT EXISTS app.team (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  game_title text NOT NULL,
  division text,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('forming','active','inactive','disbanded')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.roster_membership (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES app.team(id) ON DELETE RESTRICT,
  person_id uuid NOT NULL REFERENCES app.person_profile(id) ON DELETE RESTRICT,
  roster_role text NOT NULL,
  roster_state text NOT NULL DEFAULT 'active' CHECK (roster_state IN (
    'active','reserve','inactive','development','transfer_opportunity','released','retired'
  )),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ended_at IS NULL OR ended_at > started_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS active_roster_membership_unique
  ON app.roster_membership(team_id, person_id)
  WHERE ended_at IS NULL;

CREATE TABLE IF NOT EXISTS app.compliance_gate (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gate_key text NOT NULL,
  scope_type text NOT NULL CHECK (scope_type IN ('organization','title','event','sponsor','program','finance','travel')),
  scope_ref text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','satisfied','expired','not_applicable')),
  blocking boolean NOT NULL DEFAULT true,
  external_review_required boolean NOT NULL DEFAULT false,
  reviewer_type text,
  evidence_ref text,
  reviewed_by uuid REFERENCES app.person_profile(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (gate_key, scope_type, scope_ref)
);

CREATE INDEX IF NOT EXISTS compliance_gate_blocking_idx
  ON app.compliance_gate(scope_type, scope_ref, status)
  WHERE blocking = true;

CREATE TABLE IF NOT EXISTS app.competition_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  game_title text NOT NULL,
  engine_type text NOT NULL CHECK (engine_type IN ('bracket','league','lobby_heat','leaderboard','hybrid')),
  lifecycle_state text NOT NULL DEFAULT 'draft' CHECK (lifecycle_state IN (
    'draft','published','registration','check_in','seeding','live','qualification','finals','completed','provisional','certified','archived','cancelled'
  )),
  ruleset_version text NOT NULL,
  ruleset_snapshot jsonb NOT NULL,
  scoring_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  compliance_scope_ref text NOT NULL,
  registration_opens_at timestamptz,
  registration_closes_at timestamptz,
  starts_at timestamptz,
  integrity_window_ends_at timestamptz,
  certified_at timestamptz,
  created_by uuid REFERENCES app.person_profile(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.event_stage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES app.competition_event(id) ON DELETE RESTRICT,
  position integer NOT NULL CHECK (position > 0),
  stage_type text NOT NULL CHECK (stage_type IN ('bracket','league','lobby_heat','leaderboard','custom')),
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE(event_id, position)
);

CREATE TABLE IF NOT EXISTS app.event_participant (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES app.competition_event(id) ON DELETE RESTRICT,
  person_id uuid REFERENCES app.person_profile(id) ON DELETE RESTRICT,
  team_id uuid REFERENCES app.team(id) ON DELETE RESTRICT,
  seed integer,
  check_in_state text NOT NULL DEFAULT 'registered' CHECK (check_in_state IN ('registered','checked_in','no_show','withdrawn','disqualified')),
  registered_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((person_id IS NOT NULL) <> (team_id IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS app.event_result (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES app.competition_event(id) ON DELETE RESTRICT,
  participant_id uuid NOT NULL REFERENCES app.event_participant(id) ON DELETE RESTRICT,
  revision integer NOT NULL CHECK (revision > 0),
  state text NOT NULL CHECK (state IN ('submitted','verified','provisional','certified','corrected','voided')),
  result_data jsonb NOT NULL,
  supersedes_result_id uuid REFERENCES app.event_result(id) ON DELETE RESTRICT,
  submitted_by uuid REFERENCES app.person_profile(id) ON DELETE SET NULL,
  verified_by uuid REFERENCES app.person_profile(id) ON DELETE SET NULL,
  certified_by uuid REFERENCES app.person_profile(id) ON DELETE SET NULL,
  evidence_ref text,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(event_id, participant_id, revision),
  CHECK (verified_by IS NULL OR submitted_by IS NULL OR verified_by <> submitted_by),
  CHECK (certified_by IS NULL OR submitted_by IS NULL OR certified_by <> submitted_by)
);

CREATE INDEX IF NOT EXISTS event_result_lookup_idx ON app.event_result(event_id, participant_id, revision DESC);

CREATE TABLE IF NOT EXISTS app.creator_assignment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL REFERENCES app.person_profile(id) ON DELETE RESTRICT,
  title text NOT NULL,
  work_classification text NOT NULL CHECK (work_classification IN (
    'training_exercise','portfolio_exercise','community_contribution','volunteer_activity','paid_assignment',
    'contractor_engagement','employee_work','prize_challenge','revenue_share_project'
  )),
  compensation_summary text NOT NULL,
  rights_ref text,
  disclosure_required boolean NOT NULL DEFAULT false,
  state text NOT NULL DEFAULT 'assigned' CHECK (state IN ('draft','assigned','in_progress','review','approved','published','completed','cancelled')),
  due_at timestamptz,
  created_by uuid REFERENCES app.person_profile(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.case_record (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category text NOT NULL CHECK (category IN ('security','safeguarding','integrity','community','financial','legal','harassment','privacy','platform_outage')),
  severity text NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  state text NOT NULL DEFAULT 'intake' CHECK (state IN ('intake','triage','investigation','interim_measure','decision','appeal','closed')),
  subject_person_id uuid REFERENCES app.person_profile(id) ON DELETE RESTRICT,
  reporter_person_id uuid REFERENCES app.person_profile(id) ON DELETE SET NULL,
  anonymous_report boolean NOT NULL DEFAULT false,
  restricted boolean NOT NULL DEFAULT true,
  conflict_detected boolean NOT NULL DEFAULT false,
  independent_review_required boolean NOT NULL DEFAULT false,
  summary text NOT NULL,
  owner_person_id uuid REFERENCES app.person_profile(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);

CREATE TABLE IF NOT EXISTS app.case_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES app.case_record(id) ON DELETE RESTRICT,
  sha256 char(64) NOT NULL,
  object_ref text NOT NULL,
  source_type text NOT NULL,
  source_context jsonb NOT NULL DEFAULT '{}'::jsonb,
  submitted_by uuid REFERENCES app.person_profile(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(case_id, sha256)
);

CREATE TABLE IF NOT EXISTS app.payment_obligation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL REFERENCES app.person_profile(id) ON DELETE RESTRICT,
  source_type text NOT NULL CHECK (source_type IN ('salary','contractor','prize','revenue_share','royalty','reimbursement','other')),
  source_ref text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency char(3) NOT NULL,
  state text NOT NULL DEFAULT 'earned' CHECK (state IN ('earned','approved','scheduled','paid','reconciled','disputed','voided')),
  due_at timestamptz,
  created_by uuid NOT NULL REFERENCES app.person_profile(id) ON DELETE RESTRICT,
  approved_by uuid REFERENCES app.person_profile(id) ON DELETE RESTRICT,
  paid_by uuid REFERENCES app.person_profile(id) ON DELETE RESTRICT,
  reconciled_by uuid REFERENCES app.person_profile(id) ON DELETE RESTRICT,
  external_payment_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  paid_at timestamptz,
  reconciled_at timestamptz,
  CHECK (approved_by IS NULL OR approved_by <> created_by),
  CHECK (reconciled_by IS NULL OR reconciled_by <> created_by),
  CHECK (reconciled_by IS NULL OR approved_by IS NULL OR reconciled_by <> approved_by)
);

CREATE INDEX IF NOT EXISTS payment_obligation_state_idx ON app.payment_obligation(state, due_at);

CREATE TABLE IF NOT EXISTS app.external_identity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL REFERENCES app.person_profile(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('discord','x','twitch','youtube','playstation','xbox','steam','epic','other')),
  external_user_id text NOT NULL,
  public_handle text,
  verified_at timestamptz,
  data_scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  disconnected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider, external_user_id)
);

CREATE TABLE IF NOT EXISTS app.projection_job (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  desired_state jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','succeeded','failed','dead_letter')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.audit_event (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_person_id uuid REFERENCES app.person_profile(id) ON DELETE SET NULL,
  actor_kind text NOT NULL DEFAULT 'user' CHECK (actor_kind IN ('user','system','break_glass','external_reviewer')),
  domain text NOT NULL,
  action text NOT NULL,
  target_type text,
  target_id text,
  before_state jsonb,
  after_state jsonb,
  reason text,
  correlation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  source_ip_hash text,
  user_agent_hash text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS audit_event_target_idx ON app.audit_event(domain, target_type, target_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_event_actor_idx ON app.audit_event(actor_person_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION app.deny_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; % is not permitted', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_event_append_only ON app.audit_event;
CREATE TRIGGER audit_event_append_only
  BEFORE UPDATE OR DELETE ON app.audit_event
  FOR EACH ROW EXECUTE FUNCTION app.deny_mutation();

DROP TRIGGER IF EXISTS event_result_append_only ON app.event_result;
CREATE TRIGGER event_result_append_only
  BEFORE UPDATE OR DELETE ON app.event_result
  FOR EACH ROW EXECUTE FUNCTION app.deny_mutation();

CREATE OR REPLACE FUNCTION app.protect_event_rules() RETURNS trigger AS $$
BEGIN
  IF OLD.lifecycle_state IN ('live','qualification','finals','completed','provisional','certified','archived') THEN
    IF NEW.ruleset_version IS DISTINCT FROM OLD.ruleset_version
       OR NEW.ruleset_snapshot IS DISTINCT FROM OLD.ruleset_snapshot
       OR NEW.scoring_snapshot IS DISTINCT FROM OLD.scoring_snapshot THEN
      RAISE EXCEPTION 'event rules and scoring are locked after the event becomes live';
    END IF;
  END IF;

  IF OLD.lifecycle_state IN ('certified','archived')
     AND NEW.lifecycle_state NOT IN (OLD.lifecycle_state, 'archived') THEN
    RAISE EXCEPTION 'certified or archived event lifecycle cannot be moved backward';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS competition_event_rule_lock ON app.competition_event;
CREATE TRIGGER competition_event_rule_lock
  BEFORE UPDATE ON app.competition_event
  FOR EACH ROW EXECUTE FUNCTION app.protect_event_rules();

CREATE OR REPLACE VIEW app.blocking_compliance_gate AS
SELECT *
FROM app.compliance_gate
WHERE blocking = true
  AND (
    status IN ('open','expired')
    OR (expires_at IS NOT NULL AND expires_at <= now())
  );

COMMIT;
