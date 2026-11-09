#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo " [!] 먼저 Node.js 프로그램을 한 번만 설치해야 해요."
  echo "     곧 열리는 홈페이지에서 초록색 LTS 버튼을 눌러 내려받아 설치하세요."
  echo "     설치가 끝나면 이 파일을 다시 더블클릭하세요."
  open "https://nodejs.org/ko"
  read -p " 엔터를 누르면 창이 닫혀요."
  exit 1
fi
node server.js
