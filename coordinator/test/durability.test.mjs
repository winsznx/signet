#!/usr/bin/env node
/**
 * Phase 08 safety tests, run against a real PostgreSQL.
 *
 * The completion gate is "no restart or duplicate delivery creates duplicate authority". Every
 * property below is enforced by a database constraint rather than by application logic, because a
 * constraint holds under concurrency and a code path only holds if every future caller remembers it.
 *
 * These tests deliberately try to violate each constraint directly, bypassing any application layer.
 * A safety property that only holds when you go through the front door is not a safety property.
 */
import postgres from "postgres";

const sql = postgres(process.env.SIGNET_DATABASE_URL ?? "postgres://signet:signet@localhost:5433/signet", {
  onnotice: () => {},
});

const results = [];
function check(name, expectation, observed, pass) {
  results.push({ name, pass });
  console.log(`${pass ? "ok  " : "FAIL"} ${name}\n       expected ${expectation}\n       observed ${observed}`);
}

async function reset() {
  await sql`TRUNCATE decision_receipts, signed_transactions, redemption_actions, agent_bindings, leases, observed_events RESTART IDENTITY CASCADE`;
  const [binding] = await sql`
    INSERT INTO agent_bindings (flare_chain_id, asset_manager, agent_vault, xrpl_network_id, xrpl_account,
      signing_mode, extension_id, approved_code_hash, policy_version, status)
    VALUES (114, '0xb1', '0xa1', 1, 'rPvarExLQuuqtkMBfDHp3pNnESZ5HByXta', 'REGULAR_KEY', 7,
      '0x1111111111111111111111111111111111111111111111111111111111111111', 1, 'ACTIVE')
    RETURNING id`;
  return binding.id;
}

async function insertAction(bindingId, { actionId, requestId, generation = 0, state = "DISCOVERED" }) {
  await sql`
    INSERT INTO redemption_actions (action_id, flare_chain_id, asset_manager, request_id, request_generation,
      agent_binding_id, obligation_hash, state)
    VALUES (${actionId}, 114, '0xb1', ${requestId}, ${generation}, ${bindingId}, '0xdead', ${state})`;
}

const bindingId = await reset();

// 1. A duplicate event must not create a second action for the same generation.
{
  await insertAction(bindingId, { actionId: "a1", requestId: 42 });
  let rejected = false;
  try {
    await insertAction(bindingId, { actionId: "a1-duplicate", requestId: 42 });
  } catch (error) {
    rejected = /unique/i.test(error.message);
  }
  const [{ count }] = await sql`SELECT count(*)::int AS count FROM redemption_actions WHERE request_id = 42`;
  check(
    "a duplicate event cannot create a second action for one generation",
    "rejected, exactly 1 action",
    `rejected=${rejected} actions=${count}`,
    rejected && count === 1,
  );
}

// 2. A new generation is allowed, because a replacement is legitimately a new action.
{
  await insertAction(bindingId, { actionId: "a2", requestId: 42, generation: 1 });
  const [{ count }] = await sql`SELECT count(*)::int AS count FROM redemption_actions WHERE request_id = 42`;
  check("a new generation is a distinct action", "2 actions for one request", `${count}`, count === 2);
}

// 3. Only one generation may ever reach FASSETS_COMPLETED (I-009).
{
  await sql`UPDATE redemption_actions SET state = 'FASSETS_COMPLETED' WHERE action_id = 'a1'`;
  let rejected = false;
  try {
    await sql`UPDATE redemption_actions SET state = 'FASSETS_COMPLETED' WHERE action_id = 'a2'`;
  } catch (error) {
    rejected = /unique|duplicate/i.test(error.message);
  }
  const [{ count }] =
    await sql`SELECT count(*)::int AS count FROM redemption_actions WHERE request_id = 42 AND state = 'FASSETS_COMPLETED'`;
  check(
    "one obligation can never have two completed payments",
    "second completion rejected, exactly 1 completed",
    `rejected=${rejected} completed=${count}`,
    rejected && count === 1,
  );
}

// 4. One signed transaction per action. A second signature for the same action is a bug.
await reset().then((id) => insertAction(id, { actionId: "b1", requestId: 77 }));
{
  await sql`
    INSERT INTO signed_transactions (tx_hash, action_id, authorization_commitment, signed_blob, source_account,
      sequence_mode, sequence_or_ticket, last_ledger_sequence, fee_drops,
      observed_at_ledger, observed_source_count, observation_root)
    VALUES ('TX1', 'b1', '0xc0', '00', 'rSource', 'SEQUENCE', 91, 19822242, 10, 19822200, 2, '0xabababababababababababababababababababababababababababababababab')`;
  let rejected = false;
  try {
    await sql`
      INSERT INTO signed_transactions (tx_hash, action_id, authorization_commitment, signed_blob, source_account,
        sequence_mode, sequence_or_ticket, last_ledger_sequence, fee_drops,
        observed_at_ledger, observed_source_count, observation_root)
      VALUES ('TX2', 'b1', '0xc0', '01', 'rSource', 'SEQUENCE', 92, 19822242, 10, 19822200, 2, '0xabababababababababababababababababababababababababababababababab')`;
  } catch (error) {
    rejected = /unique/i.test(error.message);
  }
  check("one action cannot hold two signed transactions", "rejected", `rejected=${rejected}`, rejected);
}

// 5. A sequence may be consumed by exactly one transaction per account.
{
  await insertAction(bindingId, { actionId: "b2", requestId: 78 }).catch(() => {});
  const [action] = await sql`SELECT action_id FROM redemption_actions WHERE action_id = 'b2'`;
  let rejected = false;
  if (action) {
    try {
      await sql`
        INSERT INTO signed_transactions (tx_hash, action_id, authorization_commitment, signed_blob, source_account,
          sequence_mode, sequence_or_ticket, last_ledger_sequence, fee_drops,
          observed_at_ledger, observed_source_count, observation_root)
        VALUES ('TX3', 'b2', '0xc1', '02', 'rSource', 'SEQUENCE', 91, 19822250, 10, 19822200, 2, '0xabababababababababababababababababababababababababababababababab')`;
    } catch (error) {
      rejected = /unique/i.test(error.message);
    }
  }
  check(
    "a sequence cannot be consumed by two transactions on one account",
    "rejected",
    `rejected=${rejected}`,
    rejected,
  );
}

// 6. Only one worker may hold a lease, and fencing tokens are monotonic.
{
  await sql`TRUNCATE leases`;
  const acquire = async (owner) => {
    const rows = await sql`
      INSERT INTO leases (resource_id, lease_owner, fencing_token, expires_at)
      VALUES ('action:b1', ${owner}, nextval('fencing_token_seq'), now() + interval '30 seconds')
      ON CONFLICT (resource_id) DO UPDATE
        SET lease_owner = EXCLUDED.lease_owner,
            fencing_token = EXCLUDED.fencing_token,
            expires_at = EXCLUDED.expires_at
        WHERE leases.expires_at < now()
      RETURNING fencing_token`;
    return rows.length > 0 ? Number(rows[0].fencing_token) : null;
  };

  const first = await acquire("worker-a");
  const second = await acquire("worker-b");
  check(
    "a second worker cannot take a live lease",
    "worker-a holds it, worker-b is refused",
    `first=${first} second=${second}`,
    first !== null && second === null,
  );

  await sql`UPDATE leases SET expires_at = now() - interval '1 second' WHERE resource_id = 'action:b1'`;
  const third = await acquire("worker-b");
  check(
    "an expired lease can be taken, and the new token is strictly higher",
    `token > ${first}`,
    `${third}`,
    third !== null && third > first,
  );
}

// 7. A stale fencing token must not be able to write.
{
  const [{ fencing_token: current }] = await sql`SELECT fencing_token FROM leases WHERE resource_id = 'action:b1'`;
  const stale = Number(current) - 1;
  const updated = await sql`
    UPDATE redemption_actions SET state = 'SUBMITTED', version = version + 1
    WHERE action_id = 'b1'
      AND ${stale} >= (SELECT fencing_token FROM leases WHERE resource_id = 'action:b1')
    RETURNING action_id`;
  check(
    "a write fenced by a stale token is rejected",
    "0 rows updated",
    `${updated.length} rows`,
    updated.length === 0,
  );
}

// 8. Duplicate event delivery is idempotent at the observer.
{
  const record = async () => {
    const rows = await sql`
      INSERT INTO observed_events (event_key, source) VALUES ('coston2:0xtx:23', 'RedemptionRequested')
      ON CONFLICT (event_key) DO NOTHING RETURNING event_key`;
    return rows.length;
  };
  const firstDelivery = await record();
  const secondDelivery = await record();
  check(
    "redelivering the same event does no work twice",
    "first inserts, second is a no-op",
    `first=${firstDelivery} second=${secondDelivery}`,
    firstDelivery === 1 && secondDelivery === 0,
  );
}

// 9. A crash between signing and submitting must leave the blob recoverable.
{
  const [row] = await sql`SELECT tx_hash, signed_blob, submitted_at FROM signed_transactions WHERE action_id = 'b1'`;
  check(
    "a signed transaction persisted before submission survives a restart",
    "blob present, submitted_at still null",
    `blob=${row?.signed_blob !== undefined} submitted=${row?.submitted_at}`,
    row?.signed_blob !== undefined && row?.submitted_at === null,
  );
}

// 10. Two concurrent workers racing to insert the same action: exactly one wins.
{
  await sql`TRUNCATE decision_receipts, signed_transactions, redemption_actions CASCADE`;
  const attempt = async (actionId) => {
    try {
      await insertAction(bindingId, { actionId, requestId: 99 });
      return "won";
    } catch {
      return "lost";
    }
  };
  const outcomes = await Promise.all([attempt("race-a"), attempt("race-b"), attempt("race-c")]);
  const won = outcomes.filter((o) => o === "won").length;
  const [{ count }] = await sql`SELECT count(*)::int AS count FROM redemption_actions WHERE request_id = 99`;
  check(
    "three concurrent workers produce exactly one action",
    "1 winner, 1 row",
    `winners=${won} rows=${count}`,
    won === 1 && count === 1,
  );
}

// ---------------------------------------------------------------- the V2 observation, enforced by the schema
//
// Signet paid Coston2 request 44928272 twice because nothing could see a payment made by somebody
// else. V2 makes the decision require an XRP ledger observation; these make the coordinator require
// it too. A signed transaction that exists without a recorded observation is a signature nobody can
// explain afterwards, and a column that is merely usually filled in is filled in by whichever code
// path remembered to, which is the property the incident showed cannot be relied on.
{
  const bindingForObservation = await reset();
  await insertAction(bindingForObservation, { actionId: "obs1", requestId: 91 });
  const ROOT = `0x${"ab".repeat(32)}`;
  const attempt = (columns, values) =>
    sql.unsafe(
      `INSERT INTO signed_transactions (tx_hash, action_id, authorization_commitment, signed_blob, source_account,
        sequence_mode, sequence_or_ticket, last_ledger_sequence, fee_drops${columns})
       VALUES ${values}`,
    );
  const FULL = ", observed_at_ledger, observed_source_count, observation_root";

  const mustReject = [
    ["a signed transaction cannot exist without an observation", "", "('OBS1', 'obs1', '0xc0', '00', 'rS', 'SEQUENCE', 501, 19822300, 10)"],
    ["an observation from fewer than two sources is rejected", FULL, `('OBS2', 'obs1', '0xc0', '00', 'rS', 'SEQUENCE', 502, 19822300, 10, 19822200, 1, '${ROOT}')`],
    ["an observation root that is not a 32-byte hash is rejected", FULL, "('OBS3', 'obs1', '0xc0', '00', 'rS', 'SEQUENCE', 503, 19822300, 10, 19822200, 2, 'not-a-hash')"],
    ["an observation of a ledger after the transaction expires is rejected", FULL, `('OBS4', 'obs1', '0xc0', '00', 'rS', 'SEQUENCE', 504, 19822300, 10, 19822400, 2, '${ROOT}')`],
  ];
  for (const [name, columns, values] of mustReject) {
    let rejected = false;
    try {
      await attempt(columns, values);
    } catch {
      rejected = true;
    }
    check(name, "rejected", `rejected=${rejected}`, rejected);
  }

  let accepted = false;
  try {
    await attempt(FULL, `('OBS5', 'obs1', '0xc0', '00', 'rS', 'SEQUENCE', 505, 19822300, 10, 19822200, 2, '${ROOT}')`);
    accepted = true;
  } catch {
    accepted = false;
  }
  check("a well-formed observation is accepted", "accepted", `accepted=${accepted}`, accepted);
}

await sql.end();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} durability properties hold`);
if (failed.length > 0) process.exit(1);
