@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 집밥 프로젝트 은혜제 - 이 창을 닫으면 퀴즈가 꺼져요
where node >nul 2>nul
if errorlevel 1 goto NONODE
node server.js
pause
exit /b
:NONODE
echo.
echo  [!] 먼저 Node.js 프로그램을 한 번만 설치해야 해요.
echo      곧 열리는 홈페이지에서 초록색 LTS 버튼을 눌러 내려받아 설치하세요.
echo      설치가 끝나면 이 파일을 다시 더블클릭하세요.
echo.
start "" "https://nodejs.org/ko"
pause
