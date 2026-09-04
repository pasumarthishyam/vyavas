-- Pause replaces Off, and dry run is removed.
--
-- `execution_enabled = false` used to make the gate ABORT, and an abort is
-- terminal, so pausing an account permanently destroyed every case in flight
-- and switching back recovered none of them. It now parks each case in the
-- `paused` state instead, and resuming starts a fresh ladder run from the same
-- rung.
--
-- resume_count is what makes that possible. `run-ladder` dedupes on a run key
-- so a duplicate event cannot start a second ladder and double every message;
-- republishing under the original key to resume would be swallowed by that same
-- guard. The counter makes the key unique per resume, and incrementing it in a
-- conditional UPDATE is also the claim that stops the send-mode switch and the
-- sweep from both resuming the same case.
--
-- dry_run is dropped rather than left unread. The one guarantee it carried
-- survives without it: execution_enabled still defaults to false, so a new
-- merchant is paused and sends nothing until a person says otherwise.

ALTER TABLE "recovery_cases" ADD COLUMN "resume_count" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "merchants" DROP COLUMN "dry_run";