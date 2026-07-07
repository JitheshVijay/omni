-- Agent runs spawned by a workflow step are UNATTENDED: there is no user to
-- answer an ask_user question or a confirmation, so such a run must never
-- suspend. This flag lets the orchestrator drop ask_user and switch the system
-- prompt to "assume and proceed" for those runs. Interactive (UI-launched) runs
-- keep the default of 1.
ALTER TABLE agent_runs ADD COLUMN interactive INTEGER NOT NULL DEFAULT 1;
