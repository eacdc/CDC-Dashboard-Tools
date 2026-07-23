@echo off
REM ---------------------------------------------------------------------------
REM Task Scheduler entry point for the FREQUENT incremental sync (e.g. every 30
REM minutes). Runs the ALTERID-based Tally -> MongoDB incremental sync for ALL
REM branches: one lightweight metadata scan + re-pull of only the changed dates,
REM so it is safe to run often without hammering Tally.
REM
REM Prerequisites (all must be true or the sync silently does nothing):
REM   1. Tally is OPEN with the company loaded and the gateway on port 9001.
REM   2. CDC_INGEST_URL (+ optional CDC_INGEST_TOKEN) is set as a MACHINE/USER env
REM      var -- incremental REQUIRES the hosted API. (MONGODB_URI alone is not
REM      enough for incremental; it needs the /sync endpoint.)
REM   3. The task runs while a user is logged on (Tally needs the interactive
REM      session).
REM
REM Register a 30-minute repeating task (run once in an ADMIN shell, fix the path):
REM   schtasks /Create /TN "CDC_Tally_Sync_30min" /SC MINUTE /MO 30 /F ^
REM     /TR "\"C:\path\to\pipeline\run_sync.bat\""
REM ---------------------------------------------------------------------------
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0run_daily.ps1" -Incremental %*
