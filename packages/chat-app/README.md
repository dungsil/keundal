# 공용 채팅 레이어

`@keundal/chat-app`은 web과 desktop이 함께 사용하는 Nuxt 레이어입니다. `@keundal/ui`를 상속하고 페이지, 레이아웃, 채팅 상태, 모델·스킬 설정, 브라우저 저장소와 데스크톱 sidecar 연결과 공용 에셋을 제공합니다.

각 앱은 `extends: ['@keundal/chat-app']`으로 이 레이어를 사용합니다. 웹 서버·Cloudflare 배포 설정은 `apps/web`, 정적 SPA·Tauri 설정은 `apps/desktop`에서 관리합니다. `runtimeConfig.public.desktop`으로 브라우저 저장소와 데스크톱 sidecar·보안 저장소 동작을 선택합니다.

이 패키지는 앱에 의존하지 않습니다. 공용 기능은 이 레이어에서 수정하고 앱별 설정은 해당 앱에서 수정합니다.

## 검증

```sh
pnpm build
pnpm --filter @keundal/chat-app test
pnpm --filter @keundal/chat-app typecheck
pnpm --filter @keundal/chat-app lint
pnpm check:boundaries
```

공급자 연결, 채팅 저장소, 모델 목록과 스킬 테스트는 `tests/`에서 관리합니다. 웹 서버 경로와 HTTP 호스트 연동 검사는 `apps/web/tests/`에 둡니다.
