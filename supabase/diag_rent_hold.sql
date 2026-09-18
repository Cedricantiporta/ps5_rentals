-- ============================================================================
-- DIAGNOSTIC -- read-only-ish, safe to run. Finds out why create_rental_hold()
-- returns 'unexpected_error'.
--
-- WHY THIS EXISTS: create_rental_hold() deliberately swallows every error so
-- an anonymous customer never sees a raw database message. That's right for
-- production and useless for debugging, so this re-runs the same steps with
-- the error message exposed.
--
-- HOW TO RUN: new query tab, Ctrl+A to select ALL of this, Run. Then send me
-- the NOTICE lines from the output panel (the "Messages"/"Notices" area, not
-- the results grid).
--
-- It rolls back everything it creates, so it leaves no test rows behind.
-- ============================================================================

do $$
declare
  v_msg text;
  v_state text;
  v_detail text;
  v_context text;
  v_id bigint;
  v_code text;
begin
  -- Step A: can we insert a renter at all (this fires the public_code trigger)?
  begin
    insert into renters (name) values ('ZZ DIAG RENTER')
    returning id, public_code into v_id, v_code;
    raise notice 'A renters insert OK -- id=% public_code=%', v_id, v_code;
  exception when others then
    get stacked diagnostics v_msg = message_text, v_state = returned_sqlstate,
                            v_detail = pg_exception_detail, v_context = pg_exception_context;
    raise notice 'A renters insert FAILED [%] % | detail=% | context=%', v_state, v_msg, v_detail, v_context;
    v_id := null;
  end;

  -- Step B: can we insert the pending rental (fires the ref_code trigger)?
  if v_id is not null then
    begin
      insert into rentals (
        game_id, renter_id, slot, plan, amount, status, payment_status,
        start_date, end_date, hold_expires_at
      )
      select g.id, v_id, 'trophy', 'weekly', 249, 'pending', 'pending',
             current_date, current_date + 7, now() + interval '30 minutes'
        from games g where g.slug = 'zz-test-game-a';
      raise notice 'B rentals insert OK';
    exception when others then
      get stacked diagnostics v_msg = message_text, v_state = returned_sqlstate,
                              v_detail = pg_exception_detail, v_context = pg_exception_context;
      raise notice 'B rentals insert FAILED [%] % | detail=% | context=%', v_state, v_msg, v_detail, v_context;
    end;
  end if;

  -- Step C: the settings reads create_rental_hold does.
  begin
    perform (select value::int from settings where key = 'hold_minutes');
    raise notice 'C settings read OK';
  exception when others then
    get stacked diagnostics v_msg = message_text, v_state = returned_sqlstate;
    raise notice 'C settings read FAILED [%] %', v_state, v_msg;
  end;

  -- Step D: gen_code() on its own.
  begin
    raise notice 'D gen_code JD=% R=%', gen_code('JD'), gen_code('R');
  exception when others then
    get stacked diagnostics v_msg = message_text, v_state = returned_sqlstate;
    raise notice 'D gen_code FAILED [%] %', v_state, v_msg;
  end;

  -- Step E: is_own_rental(), which create_rental_hold calls.
  begin
    raise notice 'E is_own_rental(1)=%', is_own_rental(1);
  exception when others then
    get stacked diagnostics v_msg = message_text, v_state = returned_sqlstate;
    raise notice 'E is_own_rental FAILED [%] %', v_state, v_msg;
  end;

  raise exception 'DIAG_ROLLBACK -- intentional, discards the test rows above';
exception when others then
  if sqlerrm <> 'DIAG_ROLLBACK -- intentional, discards the test rows above' then
    raise notice 'OUTER FAILURE: %', sqlerrm;
  else
    raise notice 'Done -- test rows rolled back.';
  end if;
end;
$$;

-- Step F: what the function actually is right now, and who owns it.
select p.proname,
       pg_get_userbyid(p.proowner) as owner,
       p.prosecdef  as security_definer,
       p.proconfig  as settings
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('create_rental_hold','gen_code','is_own_rental',
                     'set_renter_public_code','set_rental_ref_code')
 order by p.proname;

-- Step G: is RLS *forced* on these tables? A forced table does NOT let its
-- owner bypass RLS, which would break every security-definer function.
select c.relname,
       c.relrowsecurity  as rls_enabled,
       c.relforcerowsecurity as rls_forced,
       pg_get_userbyid(c.relowner) as owner
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relname in ('renters','rentals','games','settings','swap_requests')
 order by c.relname;
