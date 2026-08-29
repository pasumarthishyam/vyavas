-- The cool-off floor was set too high.
--
-- 0003 introduced `min_gap_minutes` at 360 (six hours), reasoning that a long
-- gap is the safe direction. It is not: the floor applies to EVERY touch, and
-- the policy table deliberately places second touches much closer than that.
--
--   customer_input.incorrect_otp   0m -> 30m
--   customer_input.default         0m -> 45m
--
-- Those gaps are the point of the class. It has the highest recovery rate in
-- the taxonomy precisely because intent decays in minutes, and a six-hour floor
-- would have deferred every second rung until the ladder had moved on — turning
-- a two-touch ladder into a one-touch ladder, silently, with the deferral
-- logged as if the timing had merely been unlucky.
--
-- 15 minutes is what the floor is actually for: stopping two live cases for the
-- same person from firing near-simultaneously, and stopping a repeat a few
-- minutes after the last message. It is comfortably below every deliberate
-- rung gap in the table, so it constrains accidents and not design.

ALTER TABLE "merchants" ALTER COLUMN "min_gap_minutes" SET DEFAULT 15;

-- Existing rows were created with the 360 default and nobody chose it.
UPDATE "merchants" SET "min_gap_minutes" = 15 WHERE "min_gap_minutes" = 360;
