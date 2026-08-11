-- The observation that V2 requires, recorded as a constraint rather than a convention.
--
-- Signet paid Coston2 request 44928272 twice because nothing in the system could see a payment made
-- by somebody else. V2 makes the decision require an XRP ledger observation. This migration makes
-- the coordinator require it too: a signed transaction that exists without a recorded observation
-- is a signature nobody can explain afterwards, and the database is where "cannot exist" is cheapest
-- to enforce.
--
-- Every column is NOT NULL on purpose. A nullable observation column would be filled in by whichever
-- code path remembered to, which is exactly the property the incident showed cannot be relied on.

ALTER TABLE signed_transactions
    ADD COLUMN observed_at_ledger   BIGINT NOT NULL,
    ADD COLUMN observed_source_count SMALLINT NOT NULL,
    ADD COLUMN observation_root     TEXT NOT NULL;

-- An observation must have been taken by at least two independently operated endpoints, must name a
-- real ledger, and its root must be a 32-byte hash. These mirror the policy's own minimums so that a
-- coordinator misconfigured to accept one source cannot persist the result.
ALTER TABLE signed_transactions
    ADD CONSTRAINT observation_is_sourced CHECK (observed_source_count >= 2),
    ADD CONSTRAINT observation_names_a_ledger CHECK (observed_at_ledger > 0),
    ADD CONSTRAINT observation_root_is_a_hash CHECK (observation_root ~ '^0x[0-9a-f]{64}$');

-- The observation must not be from the future relative to the transaction it justified. A signed
-- transaction carries the ledger it was allowed to live until; an observation claiming to have seen
-- past that is incoherent.
ALTER TABLE signed_transactions
    ADD CONSTRAINT observation_precedes_expiry CHECK (observed_at_ledger < last_ledger_sequence);

COMMENT ON COLUMN signed_transactions.observation_root IS
    'keccak over what the XRP ledger observation found, as bound into the authorization commitment. Recomputable by anyone from the receipt.';
