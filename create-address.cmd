@echo off
setlocal

set /p BASE_URL=Worker URL, for example https://dazuantou.xyz: 
set /p ADMIN_TOKEN=ADMIN_TOKEN: 
set /p ADDRESS=Email address, for example user@example.com: 
set /p DISPLAY_NAME=Display name: 

if "%BASE_URL%"=="" (
  echo BASE_URL is required.
  exit /b 1
)

if "%ADMIN_TOKEN%"=="" (
  echo ADMIN_TOKEN is required.
  exit /b 1
)

if "%ADDRESS%"=="" (
  echo Email address is required.
  exit /b 1
)

curl.exe -i -X POST "%BASE_URL%/admin/address" -H "Authorization: Bearer %ADMIN_TOKEN%" -H "Content-Type: application/json" --data "{\"address\":\"%ADDRESS%\",\"displayName\":\"%DISPLAY_NAME%\"}"

echo.
endlocal
