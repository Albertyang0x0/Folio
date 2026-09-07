@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo [ERROR] 未找到项目虚拟环境。
  echo 请先运行 start.bat 完成开发环境初始化，再重新执行本脚本。
  pause
  exit /b 1
)

echo [1/4] 安装桌面打包依赖...
".venv\Scripts\python.exe" -m pip install -r "packaging\requirements-build.txt"
if errorlevel 1 goto :failed

echo [2/4] 生成 Windows 便携版目录...
".venv\Scripts\python.exe" -m PyInstaller --clean --noconfirm "FolioPortable.spec"
if errorlevel 1 goto :failed

echo [3/4] 写入便携版说明和数据目录...
copy /Y "packaging\PORTABLE_README.txt" "dist\Folio\使用说明.txt" >nul
copy /Y "LICENSE" "dist\Folio\LICENSE.txt" >nul
if not exist "dist\Folio\data" mkdir "dist\Folio\data"
copy /Y "packaging\DATA_README.txt" "dist\Folio\data\请勿删除此目录.txt" >nul

echo [4/4] 生成 ZIP...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$zip = Join-Path (Resolve-Path 'dist') 'Folio-Portable-x64.zip'; if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }; Compress-Archive -LiteralPath 'dist\Folio' -DestinationPath $zip -CompressionLevel Optimal"
if errorlevel 1 goto :failed

echo.
echo 构建完成：dist\Folio-Portable-x64.zip
echo 用户完整解压后双击 Folio\Folio.exe 即可，无需安装 Python。
pause
exit /b 0

:failed
echo.
echo [ERROR] 构建失败，请查看上方输出。
pause
exit /b 1
