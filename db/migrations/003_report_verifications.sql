-- Report verification marks — "I have checked this patient's record for this
-- period."
--
-- Run once:   psql "$DATABASE_URL" -f db/migrations/003_report_verifications.sql
--
-- Additive only: creates one new table, touches nothing existing. Safe to run
-- more than once.
--
-- WHY THE KEY IS (patient, from, to) RATHER THAN (patient, day):
--
-- A report can cover a single day or a range, and "I verified today" is not
-- the same claim as "I verified last week". Keying on the exact period means
-- ticking a patient off in the Today view never silently marks them verified
-- in a Last 7 days view that happens to contain it. Over-claiming here would
-- be worse than making someone tick twice: the whole point of the mark is
-- that it is trustworthy.

CREATE TABLE IF NOT EXISTS report_verifications (
    id                SERIAL PRIMARY KEY,
    patient_id        INT  NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    period_from       DATE NOT NULL,
    period_to         DATE NOT NULL,
    verified_by       INT,             -- doctors.id; kept even if that row goes
    verified_by_name  TEXT,            -- denormalised so the name survives
    verified_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (patient_id, period_from, period_to)
);

-- The report looks these up by period, for every patient at once.
CREATE INDEX IF NOT EXISTS idx_report_verifications_period
    ON report_verifications (period_from, period_to);
