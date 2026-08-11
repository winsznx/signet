-- Signet coordinator durable state.
--
-- The coordinator is untrusted for payment authority. Its job is to never lose a signed
-- transaction, never let two workers act on one obligation, and never let a restart or a duplicate
-- event create authority that did not exist before.
--
-- Every safety property below is a database constraint rather than application logic, because a
-- constraint holds under concurrency and a code path does not.

CREATE TABLE agent_bindings (
    id                  BIGSERIAL PRIMARY KEY,
    flare_chain_id      NUMERIC(78, 0) NOT NULL,
    asset_manager       TEXT NOT NULL,
    agent_vault         TEXT NOT NULL,
    xrpl_network_id     INTEGER NOT NULL,
    xrpl_account        TEXT NOT NULL,
    signing_mode        TEXT NOT NULL CHECK (signing_mode IN ('REGULAR_KEY', 'SIGNER_LIST')),
    extension_id        NUMERIC(78, 0) NOT NULL,
    approved_code_hash  TEXT NOT NULL,
    policy_version      INTEGER NOT NULL,
    status              TEXT NOT NULL CHECK (status IN ('ACTIVE', 'PAUSED', 'RETIRED')),
    activated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    retired_at          TIMESTAMPTZ,
    UNIQUE (flare_chain_id, asset_manager, agent_vault)
);

-- The replay guard, as a constraint. PRD section 14.2 names exactly this uniqueness, and putting it
-- in the schema means a duplicate event cannot create a second action even if two workers race.
CREATE TABLE redemption_actions (
    action_id                  TEXT PRIMARY KEY,
    flare_chain_id             NUMERIC(78, 0) NOT NULL,
    asset_manager              TEXT NOT NULL,
    request_id                 NUMERIC(78, 0) NOT NULL,
    request_generation         INTEGER NOT NULL CHECK (request_generation >= 0),
    agent_binding_id           BIGINT NOT NULL REFERENCES agent_bindings (id),
    obligation_hash            TEXT NOT NULL,
    state                      TEXT NOT NULL,
    reason_code                TEXT,
    first_underlying_block     NUMERIC(78, 0),
    last_underlying_block      NUMERIC(78, 0),
    last_underlying_timestamp  NUMERIC(78, 0),
    created_block              BIGINT,
    created_tx_hash            TEXT,
    version                    INTEGER NOT NULL DEFAULT 0,
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (flare_chain_id, asset_manager, request_id, request_generation)
);

-- At most one validated successful payment per obligation, enforced by the database rather than by
-- the code that would otherwise have to remember (I-009).
CREATE UNIQUE INDEX one_successful_payment_per_request
    ON redemption_actions (flare_chain_id, asset_manager, request_id)
    WHERE state = 'FASSETS_COMPLETED';

CREATE TABLE signed_transactions (
    tx_hash                TEXT PRIMARY KEY,
    action_id              TEXT NOT NULL REFERENCES redemption_actions (action_id),
    authorization_commitment TEXT NOT NULL,
    signed_blob            TEXT NOT NULL,
    source_account         TEXT NOT NULL,
    sequence_mode          TEXT NOT NULL CHECK (sequence_mode IN ('SEQUENCE', 'TICKET')),
    sequence_or_ticket     BIGINT NOT NULL,
    last_ledger_sequence   BIGINT NOT NULL,
    submitted_at_ledger    BIGINT,
    fee_drops              NUMERIC(78, 0) NOT NULL,
    persisted_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    submitted_at           TIMESTAMPTZ,
    validated_ledger       BIGINT,
    engine_result          TEXT,
    final_status           TEXT
);

-- One signed transaction per action generation. A second signature for the same generation is a
-- bug, and the database says so rather than the coordinator hoping.
CREATE UNIQUE INDEX one_signed_transaction_per_action ON signed_transactions (action_id);

-- A sequence or ticket may be consumed by exactly one signed transaction per account.
CREATE UNIQUE INDEX one_transaction_per_sequence
    ON signed_transactions (source_account, sequence_mode, sequence_or_ticket);

CREATE TABLE leases (
    resource_id   TEXT PRIMARY KEY,
    lease_owner   TEXT NOT NULL,
    fencing_token BIGINT NOT NULL,
    expires_at    TIMESTAMPTZ NOT NULL
);

-- Fencing tokens are globally monotonic. A worker holding an old token can be detected as stale
-- even after its lease has been reassigned (NFR-011).
CREATE SEQUENCE fencing_token_seq AS BIGINT START 1;

CREATE TABLE decision_receipts (
    id            BIGSERIAL PRIMARY KEY,
    action_id     TEXT NOT NULL REFERENCES redemption_actions (action_id),
    decision      TEXT NOT NULL CHECK (decision IN ('AUTHORIZE', 'REFUSE')),
    reason_code   TEXT,
    policy_version INTEGER NOT NULL,
    code_hash     TEXT NOT NULL,
    result_hash   TEXT,
    recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (action_id, decision, reason_code)
);

CREATE TABLE observed_events (
    event_key    TEXT PRIMARY KEY,
    source       TEXT NOT NULL,
    observed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
