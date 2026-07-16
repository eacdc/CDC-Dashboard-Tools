@echo off
REM Task Scheduler entry point. Point a Basic Task's Action here.
REM Runs the daily Tally -> MongoDB pull for all configured branches.
REM Set MONGODB_URI (or CDC_INGEST_URL / CDC_INGEST_TOKEN) as machine env vars first.
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0run_daily.ps1" %*
