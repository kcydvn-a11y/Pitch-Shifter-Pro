@echo off
chcp 65001 >nul
set "TARGET_DIR=%~dp0"
cd /d "%TARGET_DIR%"

echo [1/4] Dang tai ban cap nhat (Thu link Google Drive)...
powershell -Command "try { Invoke-WebRequest -Uri 'https://drive.usercontent.google.com/download?id=1D_HKhG5tMM3xcQMLL1udhhH82aKcbZZb&export=download&confirm=t' -OutFile 'update_temp.zip'; exit 0 } catch { exit 1 }"

:: Kiểm tra xem file tải về từ Drive có thực sự tồn tại và dung lượng > 0 hay không
if exist "update_temp.zip" (
    for %%A in ("update_temp.zip") do if %%~zA GTR 1000 goto EXTRACT
)

echo [!] Link Google Drive khong kha dung. Dang chuyen sang tai tu GitHub...
powershell -Command "Invoke-WebRequest -Uri 'https://github.com/kcydvn-a11y/Pitch-Shifter-Pro/archive/refs/heads/main.zip' -OutFile 'update_temp.zip'"

if not exist "update_temp.zip" (
    echo [LOI] Khong the tai xuong tu ca 2 nguon! Vui long kiem tra lai mang.
    exit /b
)

:EXTRACT
echo [2/4] Dang giai nen tep cap nhat...
powershell -Command "Expand-Archive -Path 'update_temp.zip' -DestinationPath 'update_extracted' -Force"

echo [3/4] Dang ghi de ma nguon moi...
:: Tự động quét xem file giải nén theo cấu trúc Google Drive hay GitHub để copy chính xác nhất
if exist "update_extracted\REMOVEADBLOCK-PRO-main" (
    xcopy /s /y "update_extracted\REMOVEADBLOCK-PRO-main\*" "%TARGET_DIR%" >nul
) else (
    xcopy /s /y "update_extracted\*" "%TARGET_DIR%" >nul
)

echo [4/4] Don dep tep tam...
del /f /q "update_temp.zip"
rd /s /q "update_extracted"
exit