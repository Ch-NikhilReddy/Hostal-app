@echo off
title HostelMitra - Auto Launcher
color 0A

echo.
echo ============================================
echo  Starting HostelMitra Full Stack...
echo ============================================
echo.

:: Step 1: Ensure Docker/PostgreSQL is running
echo.
echo [Step 1] Checking Docker...
docker ps >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Docker not running. Please start Docker Desktop.
    pause
    exit /b
)
echo [OK] Docker is running.

:: Step 2: Start PostgreSQL
echo.
echo [Step 2] Starting PostgreSQL...
npm run db:up
echo [OK] PostgreSQL started.

:: Step 3: Deploy migrations
echo.
echo [Step 3] Deploying database migrations...
npm run db:deploy
echo [OK] Migrations deployed.

:: Step 4: Seed database
echo.
echo [Step 4] Seeding database with test data...
npm run db:seed
echo [OK] Database seeded.

:: Step 5: Start API Server
echo.
echo [Step 5] Starting API Server (port 4000)...
start "" powershell -NoProfile -ExecutionPolicy Bypass -Command "cd C:\Users\nikhi\Documents\hostel-app\api && npm run api"
timeout /t 5 /nobreak >nul
echo [OK] API Server started.

:: Step 6: Start Web Dashboard
echo.
echo [Step 6] Starting Web Dashboard (port 5173)...
start "" powershell -NoProfile -ExecutionPolicy Bypass -Command "cd C:\Users\nikhi\Documents\hostel-app\web && npm run dev"
timeout /t 5 /nobreak >nul
echo [OK] Web Dashboard started.

:: Step 7: Start Expo Go
echo.
echo [Step 7] Starting Mobile App (Expo Go)...
start "" powershell -NoProfile -ExecutionPolicy Bypass -Command "cd C:\Users\nikhi\Documents\hostel-app\app && npm run start"
timeout /t 8 /nobreak >nul
echo [OK] Expo Metro bundler started.

echo.
echo ============================================
echo  HOSTELMITRA FULLY STARTED!
echo ============================================
echo.
echo  API Server:      http://localhost:4000
echo  Web Dashboard:   http://localhost:5173
echo  Metro/Expo:      http://localhost:8081 (scan QR with Expo Go)
echo.
echo  Demo Accounts:
echo  -------------
echo  Admin:    9000000001
echo  Owner:    9000000002 (Ravi Kumar - APPROVED)
echo  Owner:    9000000003 (Sheikh - PENDING)
echo  Student:  9876543210 (1 confirmed booking)
echo.
echo.
echo  Press any key to continue or close this window...
pause >nul