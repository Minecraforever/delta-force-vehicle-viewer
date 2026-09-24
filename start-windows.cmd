@echo off
rem 三角洲行动 · 全面战场载具可视化 —— Windows 启动器
rem 双击本文件即可：用 Windows 自带的组件起一个只读小服务，然后自动打开浏览器。
rem 关掉这个窗口就是停止服务，不需要安装 Python、Node 或其它运行库。
rem
rem 本文件是 UTF-8 编码（不带 BOM），下面这行切到 UTF-8 代码页才能正常显示中文。
rem 如果你的系统太老显示乱码，把下面这行换成 chcp 936 并把本文件另存为 GBK 即可。

chcp 65001 >nul
setlocal
title 三角洲行动 · 全面战场载具可视化
echo.
echo   正在启动本地服务，马上会用浏览器打开页面...
echo   关闭这个窗口即停止服务。
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-windows.ps1"
if errorlevel 1 pause
endlocal
