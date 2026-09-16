# 기여하기

## 이슈 만들기

[버그 보고](.github/ISSUE_TEMPLATE/BUG_REPORT.md), [기능 제안](.github/ISSUE_TEMPLATE/FEATURE_REQUEST.md), [하위 작업](.github/ISSUE_TEMPLATE/TASK.md) 중 맞는 템플릿을 사용합니다. 본문은 한국어로 작성하고, 해당 내용이 없는 섹션은 생략합니다.

## 커밋 메시지 규칙

Conventional Commits 형식을 따릅니다: `<type>(<scope>): <subject>`

- 사용 가능한 `type`은 `feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `build`, `ci`, `chore`, `revert`입니다.
- `subject`는 한국어 평서문으로 작성하고, 80자 이내로 제한하며, 끝에 마침표를 찍지 않습니다.
- `scope`는 선택 사항입니다. 영문 소문자로 모듈이나 도메인 이름을 사용합니다(예: `auth`, `api`, `ui`).
- 커밋 제목에는 이슈 번호를 포함하지 않습니다.
- `body`에는 파일 목록이 아니라 변경이 필요한 이유(WHY)를 설명하고, 줄당 120자 이내로 줄바꿈합니다. `subject`만으로 충분히 설명된다면 생략할 수 있습니다.
- 호환성을 깨뜨리는 변경에는 `type` 뒤에 `!`를 추가하고(예: `feat!:`), `body`에 마이그레이션 방법을 설명합니다.
- `revert` 커밋은 `body`에 원본 커밋의 해시를 반드시 명시합니다.

## Pull Request 규칙

- PR 제목은 위 커밋 메시지 규칙을 따릅니다.
- PR 본문은 한국어로 [PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md)를 따릅니다. 해당 내용이 없는 섹션은 생략합니다.
- 관련 이슈가 있으면 본문의 `Closes #<이슈 번호>`로 연결합니다.

## 라이선스

이 프로젝트는 [MIT License](./LICENSE)에 따라 배포됩니다. 기여한 코드는 동일한 라이선스로 배포됩니다.
