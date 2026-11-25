@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Đẩy ChiTieuHangNgay lên GitHub
echo ==== ĐẨY CHITIEUHANGNGAY LÊN GITHUB ====
echo.

where git >nul 2>nul
if errorlevel 1 goto :chua_cai_git

set REPO=https://github.com/lexkhero/ChiTieuHangNgay.git

if exist ".git" goto :da_ket_noi
echo Lần đầu chạy: đang kết nối thư mục này với GitHub...
git init -q || goto :loi
git remote add origin %REPO% || goto :loi
git fetch origin || goto :loi
set BR=main
git rev-parse --verify -q origin/main >nul 2>nul || set BR=master
git symbolic-ref HEAD refs/heads/%BR% || goto :loi
git reset -q origin/%BR% || goto :loi
echo Đã kết nối xong.
echo.

:da_ket_noi
git config user.name >nul 2>nul || git config user.name lexkhero
git config user.email >nul 2>nul || git config user.email lexkhero@users.noreply.github.com
for /f "delims=" %%b in ('git branch --show-current') do set BR=%%b

git add -A
git diff --cached --quiet && goto :khong_doi

rem Chặn nhầm file dữ liệu riêng tư
git diff --cached --name-only | findstr /i /c:"seed-" /c:".bak" >nul && goto :nguy_hiem

echo Các file sẽ được đẩy lên:
git diff --cached --name-status
echo.
set "MSG="
set /p MSG=Nhập ghi chú cho lần cập nhật này (bỏ trống bấm Enter để dùng mặc định): 
if "%MSG%"=="" set "MSG=Cap nhat %date% %time:~0,5%"
git commit -q -m "%MSG%" || goto :loi
git push -u origin %BR% || goto :loi
echo.
echo ĐÃ ĐẨY XONG. Chờ khoảng 2 phút rồi mở trang web và bấm Ctrl + F5.
pause
exit /b 0

:khong_doi
echo Không có thay đổi nào so với trên GitHub, không cần đẩy.
pause
exit /b 0

:nguy_hiem
echo DỪNG LẠI: phát hiện file seed-*.json hoặc *.bak trong danh sách đẩy lên.
echo Các file này chứa dữ liệu chi tiêu riêng tư, KHÔNG được đưa lên GitHub công khai.
echo Hãy chuyển chúng ra khỏi thư mục này (ví dụ E:\) rồi chạy lại.
git reset -q
pause
exit /b 1

:chua_cai_git
echo CHƯA CÀI GIT. Tải và cài Git for Windows tại: https://git-scm.com/download/win
echo (cài xong cứ bấm Next đến hết), sau đó chạy lại file này.
pause
exit /b 1

:loi
echo.
echo CÓ LỖI khi chạy git (xem dòng báo lỗi phía trên).
echo Nếu hiện cửa sổ đăng nhập GitHub thì đăng nhập tài khoản lexkhero rồi chạy lại.
pause
exit /b 1
