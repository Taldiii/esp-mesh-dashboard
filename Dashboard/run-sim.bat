@echo off
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo No virtual environment found. Run run.bat once, then retry.
    exit /b 1
)

echo Starting simulated mesh + dashboard on http://127.0.0.1:8000
".venv\Scripts\python.exe" simulate_mesh.py
if errorlevel 1 pause
