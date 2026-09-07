-- Revocable long-lived credentials for machines, not people.
--
-- WHY THIS EXISTS
-- The iOS Shortcut that files a PostureScreen PDF into a patient's record has
-- to hold a credential on the phone. Handing it an ordinary login JWT is a bad
-- trade: this deployment runs JWT_EXPIRES_IN=never, and even when it does not,
-- a signed JWT cannot be withdrawn. Disabling the account does not help —
-- is_active is only read at login — so the sole remedy for a lost phone is
-- rotating JWT_SECRET, which logs out the entire clinic at once.
--
-- A row per credential fixes that. The phone holds a refresh token, exchanges
-- it for a 15-minute access token on each use, and revoking one phone is one
-- UPDATE that touches nobody else.
--
-- WHAT IS STORED
-- Only a SHA-256 hash of the token. The plaintext is shown once, when it is
-- issued, and never again — the same reason password_hash exists rather than
-- password. Someone reading a database backup learns nothing they can use.
--
-- The subject columns are a snapshot of whose identity the token acts as, so
-- an access token can be minted without a second lookup, and so a revoked
-- row still says who it belonged to when the question comes up later.
--
-- Safe to run more than once.

CREATE TABLE IF NOT EXISTS service_refresh_tokens (
    id            SERIAL PRIMARY KEY,

    -- SHA-256 of the plaintext token, hex. Never the token itself.
    token_hash    TEXT NOT NULL UNIQUE,

    -- Which phone or shortcut this went to, so revoking the right one does
    -- not become guesswork six months from now.
    label         TEXT,

    -- Whose identity requests made with this token carry. Mirrors the JWT
    -- payload the access token will be signed with.
    subject_id    INT  NOT NULL,
    subject_role  TEXT NOT NULL,
    subject_name  TEXT NOT NULL,

    -- The admin who issued it.
    created_by    INT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Answers "is this thing still in use?" before anyone revokes it, and
    -- shows up a stolen token being exercised from somewhere unexpected.
    last_used_at  TIMESTAMPTZ,
    use_count     INT NOT NULL DEFAULT 0,

    -- Set, never deleted. The history of what was issued is worth keeping.
    revoked_at    TIMESTAMPTZ
);

-- The refresh endpoint looks up live tokens on every call; this keeps that to
-- an index hit even once the table has years of revoked rows in it.
CREATE INDEX IF NOT EXISTS idx_service_refresh_tokens_live
    ON service_refresh_tokens (token_hash)
    WHERE revoked_at IS NULL;
