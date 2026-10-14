@echo off
title HostelMitra - Full Stack Launcher
color 0A

echo.
echo ==========================================
echo  HostelMitra - Starting All Services...
echo ==========================================
echo.

:: Step 1: Check Docker/PostgreSQL
echo.
echo [1/7] Checking Docker...
docker ps >nul 2>&1
if %errorlevel% neq 0 (
    echo [INFO] Starting Docker compose...
    npm run db:up
) else (
    echo [OK] PostgreSQL already running.
)
timeout /t 3 /nobreak >nul

:: Step 2: Deploy migrations
echo.
echo [2/7] Deploying database migrations...
npm run db:deploy
timeout /t 3 /nobreak >nul

:: Step 3: Seed database
echo.
echo [3/7] Seeding database with test data...
npm run db:seed
timeout /t 3 /nobreak >nul

:: Step 4: Start API Server
echo.
echo [4/7] Starting API Server (port 4000)..
cd C:\Users\nikhi\Documents\hostel-app\api
powershell -NoProfile -ExecutionPolicy Bypass -Command "npm run api" >nul 2>&1 &
echo  API Server starting...

:: Step 5: Start Web Dashboard
echo.
echo [5/7] Starting Web Dashboard (port 5173)..
cd C:\Users\nikhi\Documents\hostel-app\web
powershell -NoProfile -ExecutionPolicy Bypass -Command "npm run dev" >nul 2>&1 &
echo  Web Dashboard starting...

:: Step 6: Start Expo Go
echo.
echo [6/7] Starting Mobile App (Expo Go)..
cd C:\Users\nikhi\Documents\hostel-app\app
powershell -NoProfile -ExecutionPolicy Bypass -Command "npm run start" >nul 2>&1 &
echo  Expo Metro bundler starting...

echo.
echo ==========================================
echo  HostelMitra Services Launching...
echo ==========================================
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
echo  All services are launching in background.
echo  Wait 2-3 minutes, then check the URLs above.
echo.
echo  To exit, close all opened windows.
echo.
pause >nul