@echo off
title HostelMitra - Launch Dashboard
color 0A

echo.
echo ==========================================
echo  HostelMitra - Student Hostel/PG Booking
echo ==========================================
echo.

:: Step 1: Ensure Docker PostgreSQL is running
echo.
echo [1/3] Checking PostgreSQL Docker...
docker ps >nul 2>&1
if %errorlevel% neq 0 (
    echo [INFO] Starting PostgreSQL Docker...
    npm run db:up
) else (
    echo [OK] PostgreSQL already running.
)

:: Step 2: Ensure database is seeded
echo.
echo [2/4] Ensuring database seeded...
npm run db:deploy >nul 2>&1
npm run db:seed >nul 2>&1

:: Step 3: Open web dashboard in browser
echo.
echo [3/4] Opening Web Dashboard in browser...
start "" http://localhost:5173

echo.
echo ==========================================
echo  HostelMitra Dashboard Open!
echo ==========================================
echo.
echo  Web Dashboard:   http://localhost:5173 (opened in browser)
echo  API Server:      http://localhost:4000 (run: npm run api from api/ folder)
echo.
echo  Demo Accounts:
echo  -------------
echo  Admin:    9000000001   (full access - verification, commission, reports)
echo  Owner:    9000000002   (Ravi Kumar Hostels - APPROVED)
echo  Owner:    9000000003   (Sheikh Hostels - PENDING approval)
echo  Student:  9876543210   (has one confirmed booking)
echo.
echo  Mobile App (Expo Go):
echo  1. Install Expo Go from app store
echo  2. Run: npm run start --workspace app
echo  3. Scan QR code from http://localhost:8081
echo.
echo  Press any key to continue...
pause >nul