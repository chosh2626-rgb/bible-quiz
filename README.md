# 전도회 성경 퀴즈 대회

앞 화면의 QR코드로 휴대폰이 접속해, 문제가 나오면 답을 제출하고 전도회별 순위를 매기는 실시간 퀴즈입니다.

- 남전도회 6곳, 여전도회 16곳
- 객관식 · O/X · 주관식, 정답 500점 + 빠르기 점수 최대 500점
- 진행자 화면: 서버 주소를 그대로 열기 / 참가자: 화면의 QR 또는 링크

## 실행

```bash
npm install
```

```bash
npm start
```

화면을 고칠 때는 `src/template.html`을 수정한 뒤 `npm run build`로 `index.html`을 다시 만듭니다.

Render에는 `render.yaml` 설정으로 올립니다.
