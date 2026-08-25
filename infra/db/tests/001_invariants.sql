\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
  person_a uuid := gen_random_uuid();
  person_b uuid := gen_random_uuid();
  event_id uuid := gen_random_uuid();
  participant_id uuid := gen_random_uuid();
  result_id uuid := gen_random_uuid();
  audit_id bigint;
  blocked boolean;
  blocking_count integer;
BEGIN
  INSERT INTO app.person_profile (id, auth_user_id, display_name)
  VALUES
    (person_a, 'db-invariant-a', 'DB Invariant A'),
    (person_b, 'db-invariant-b', 'DB Invariant B');

  INSERT INTO app.audit_event (actor_person_id, domain, action, target_type, target_id)
  VALUES (person_a, 'test', 'audit.created', 'test', 'db-invariant')
  RETURNING id INTO audit_id;

  blocked := false;
  BEGIN
    UPDATE app.audit_event SET action = 'audit.tampered' WHERE id = audit_id;
  EXCEPTION WHEN OTHERS THEN
    blocked := true;
  END;
  IF NOT blocked THEN
    RAISE EXCEPTION 'audit_event accepted an UPDATE despite append-only invariant';
  END IF;

  INSERT INTO app.competition_event (
    id, name, game_title, engine_type, lifecycle_state,
    ruleset_version, ruleset_snapshot, scoring_snapshot, compliance_scope_ref, created_by
  ) VALUES (
    event_id, 'Invariant Event', 'Test Title', 'bracket', 'live',
    'v1', '{"rules":"locked"}', '{"win":1}', 'test-title', person_a
  );

  blocked := false;
  BEGIN
    UPDATE app.competition_event
      SET scoring_snapshot = '{"win":999}'::jsonb
      WHERE id = event_id;
  EXCEPTION WHEN OTHERS THEN
    blocked := true;
  END;
  IF NOT blocked THEN
    RAISE EXCEPTION 'live competition event accepted scoring mutation';
  END IF;

  INSERT INTO app.event_participant (id, event_id, person_id)
  VALUES (participant_id, event_id, person_a);

  INSERT INTO app.event_result (
    id, event_id, participant_id, revision, state, result_data, submitted_by
  ) VALUES (
    result_id, event_id, participant_id, 1, 'submitted', '{"score":1}', person_a
  );

  blocked := false;
  BEGIN
    UPDATE app.event_result SET result_data = '{"score":999}'::jsonb WHERE id = result_id;
  EXCEPTION WHEN OTHERS THEN
    blocked := true;
  END;
  IF NOT blocked THEN
    RAISE EXCEPTION 'event_result accepted an UPDATE despite append-only invariant';
  END IF;

  blocked := false;
  BEGIN
    INSERT INTO app.payment_obligation (
      person_id, source_type, source_ref, amount_minor, currency,
      created_by, approved_by
    ) VALUES (
      person_b, 'other', 'db-invariant-self-approval', 1000, 'USD',
      person_a, person_a
    );
  EXCEPTION WHEN check_violation THEN
    blocked := true;
  END;
  IF NOT blocked THEN
    RAISE EXCEPTION 'payment obligation allowed creator to approve own obligation';
  END IF;

  INSERT INTO app.compliance_gate (
    gate_key, scope_type, scope_ref, status, blocking, expires_at
  ) VALUES (
    'db-invariant-expired', 'title', 'test-title', 'satisfied', true, now() - interval '1 minute'
  );

  SELECT count(*) INTO blocking_count
  FROM app.blocking_compliance_gate
  WHERE gate_key = 'db-invariant-expired' AND scope_type = 'title' AND scope_ref = 'test-title';

  IF blocking_count <> 1 THEN
    RAISE EXCEPTION 'expired satisfied compliance gate did not become blocking';
  END IF;
END;
$$;

ROLLBACK;
