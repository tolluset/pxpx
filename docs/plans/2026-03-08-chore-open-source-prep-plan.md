---
title: "chore: Prepare public open-source release"
type: chore
status: active
date: 2026-03-08
---

# chore: Prepare public open-source release

## Overview
현재 저장소는 개인 운영 서비스와 로컬 개발 기준으로는 이미 usable한 상태다. 다만 공개 저장소로 전환하기 전에 법적 소유권, 비밀정보, 운영 인프라 의존성, 커뮤니티 문서, 릴리스 자동화를 분리해서 정리해야 한다.

이번 플랜의 목적은 "바로 공개"가 아니라 "무엇을 공개할지 먼저 확정하고, 공개 차단 요소를 순서대로 제거하는 것"이다.

2026-03-08 진행 메모:
- 공개 범위는 `client + Cloudflare worker + local build/release scripts`로 확정
- SSH gateway는 저장소에 포함하되 기본 공개 경로가 아닌 고급 운영 옵션으로 분류
- 기본 런타임은 maintainer-run shared Worker가 아니라 로컬 서버와 self-host 명시 opt-in으로 전환

## Research Summary

### Local repo findings
- 최소 품질 기준은 존재한다.
  - `pnpm typecheck` passes on 2026-03-08
  - `README.md`, `install.sh`, `scripts/build-client.sh`, `scripts/package-release.sh`, `wrangler.toml`까지 기본 실행/배포 경로는 문서화되어 있다.
- 공개 저장소 기본 세트는 2026-03-08에 추가 완료.
  - `LICENSE`, `CONTRIBUTING`, `CODE_OF_CONDUCT`, `SECURITY`, `.github/` templates
- 패키지는 아직 비공개 설정이다.
  - `package.json:4` -> `"private": true`
- 공개 배포 기준의 기본 설치 경로가 미완성이다.
  - `install.sh:8-10` -> `DEFAULT_REPO=""`
- 클라이언트와 README의 기본 런타임은 2026-03-08에 self-host/local-first로 전환 완료.
- README의 한국어 링크는 2026-03-08에 `README.ko.md` 추가로 복구 완료.
- 환경파일 추적 방지는 2026-03-08에 보강 완료.
  - `.gitignore`에 `.env`, `.env.*`, 로컬 도구 디렉터리 ignore 규칙 추가
  - 현재 작업 트리에는 추적 중인 `.env*` 파일은 발견되지 않음
- 테스트/CI는 아직 약하다.
  - 타입체크 스크립트는 있으나 테스트 파일과 GitHub Actions는 찾지 못함
- secret scan 결과:
  - 현재 저장소와 git 히스토리에서 일반적인 credential value 패턴은 발견하지 못함
  - 환경변수 이름과 운영 문서용 placeholder만 존재
  - 과거 `.ralph/` 히스토리에 로컬 절대경로(`/Users/bh/...`) 흔적은 있으나 credential 자체는 아님

### Institutional learnings
- `docs/solutions/`에는 현재 UI 관련 문서 1건만 있고, 공개 전환과 직접 관련된 누적 학습 문서는 없다.
- 따라서 이번 플랜은 저장소 실사 결과를 기준으로 작성한다.

### External research decision
- 이번 작업은 일반론보다 현재 저장소의 공개 준비도와 운영 경계가 더 중요하다.
- 외부 리서치는 생략하고 로컬 근거 중심으로 진행한다.

## Problem Statement
공개 저장소로 전환할 때 가장 큰 리스크는 다음 네 가지다.

1. 공개 범위가 불명확하다.
2. 현재 운영 중인 인프라 기본값이 코드와 문서에 섞여 있다.
3. 커뮤니티/법적 문서가 비어 있다.
4. 공개 후 재현성과 릴리스 자동화를 보장하는 최소 품질 게이트가 없다.

## Recommendation
권장 방향은 다음과 같다.

- 코드 공개 범위는 우선 `client + cloudflare worker + local build scripts`까지로 본다.
- `pxpx.sh` 같은 운영 도메인과 실제 shared worker는 "관리형 서비스"로 분리해서 다룬다.
- 공개 저장소는 self-host 가능해야 하고, 관리형 기본값 사용 여부는 명시적 선택으로 바꾼다.

즉, "운영 서비스가 붙어 있으면 더 편한 오픈소스"로 만들되, "운영 서비스 없이는 동작 설명이 불가능한 저장소" 상태는 피하는 것이 좋다.

## Decision Gates

### 1. 공개 범위 결정
- 오픈소스로 공개할 범위를 확정한다.
  - A안: terminal client만 공개
  - B안: client + worker 공개
  - C안: client + worker + ssh gateway 모두 공개
- 결정:
  - B안을 기본 공개 범위로 채택
  - SSH gateway는 저장소에 남기되 고급 운영 옵션으로 분류

### 2. 관리형 인프라 정책
- 기본 Worker URL을 계속 제품 기본값으로 둘지 결정한다.
- `pxpx.sh`를 README 전면에 둘지, "hosted option"으로 내릴지 결정한다.
- GitHub 로그인 Worker를 public demo 용도로 제공할지, self-host만 공식 지원할지 결정한다.
- 결정:
  - maintainer-run shared Worker는 기본값에서 제거
  - `pxpx.sh`류 SSH 진입점은 hosted option으로만 다룸
  - GitHub login은 self-hosted Worker 또는 로컬 direct device flow 기준으로 문서화

### 3. 공개 후 지원 범위
- 버그 triage 범위, 보안 제보 채널, 릴리스 cadence, breaking change 정책을 정한다.

## Workstreams

### 1. Legal and ownership
- 코드, 문서, 아이콘, 브랜드명(`Pixel Game`, `pxboard`, `pxpx.sh`)의 소유권과 공개 가능 여부를 확인한다.
- 사용할 라이선스를 결정한다.
  - 권장 출발점: `MIT` 또는 `Apache-2.0`
  - Worker 운영 정책이나 상표 보호를 강하게 가져갈 생각이면 별도 trademark note 추가 검토
- 주요 의존성 라이선스 점검을 수행한다.
- 첫 공개 전에 `LICENSE` 파일을 추가한다.

### 2. Secrets and security audit
- 전체 git 히스토리 기준으로 secret scan을 수행한다.
  - 목표: Cloudflare tokens, GitHub client ID/secret류, session secret, reset token, 개인 경로/도메인 잔존 여부 확인
- `.gitignore`에 `.env`, `.env.*`, local credential artifacts를 추가한다.
- 공개 전 `.env.example` 또는 setup 섹션으로 필요한 환경변수 목록을 정리한다.
- Worker admin/reset/auth 경로의 공개 문서 수준을 재검토한다.
  - `README.md:216-254`
  - `cloudflare/worker.ts`
- 이미 외부 공유 이력이 있거나 노출 가능성이 있으면 `GITHUB_SESSION_SECRET`, `ROOM_RESET_TOKEN`, Cloudflare credentials를 rotation 대상으로 잡는다.

### 3. Product and infra boundary cleanup
- 현재 hardcoded default endpoint 정책을 재정리한다.
  - 현행 근거: `src/client.tsx:167-168`, `README.md:42`, `README.md:245-246`
- 선택지:
  - A안: shared Worker를 그대로 기본값으로 유지하고 "best-effort managed service"라고 명시
  - B안: 기본값을 제거하고 self-host URL 입력 또는 local server를 기본값으로 변경
- 공개 첫날 기준으로는 B안이 더 안전하다.
- `install.sh`의 공개 저장소 slug를 확정 후 채운다.
  - `install.sh:8-10`
- `wrangler.toml`과 README를 self-host 기준으로 다시 읽어도 바로 따라 할 수 있게 정리한다.

### 4. Repository and community readiness
- README의 깨진 링크를 수정하거나 `README.ko.md`를 추가한다.
  - `README.md:5`
- 공개 저장소 기본 파일을 추가한다.
  - `LICENSE`
  - `CONTRIBUTING.md`
  - `CODE_OF_CONDUCT.md`
  - `SECURITY.md`
  - `.github/ISSUE_TEMPLATE/*`
  - `.github/pull_request_template.md`
- README를 두 개의 경로로 분리해서 명확히 쓴다.
  - Local-only quickstart
  - Hosted/self-hosted worker quickstart
- "이 저장소만 clone해서 어디까지 재현 가능한가"를 README 첫 화면에서 바로 이해할 수 있게 바꾼다.

### 5. Quality gates and automation
- GitHub Actions 기반 최소 CI를 추가한다.
  - `pnpm install`
  - `pnpm typecheck`
  - `pnpm build:client`
- 가능하면 install smoke test도 넣는다.
  - source checkout install
  - packaged tarball install
- 테스트가 아직 없다면 최소 smoke-level validation 기준을 문서화한다.
- 첫 공개 태그 이전에 clean environment 재현 테스트를 수행한다.

### 6. Release and launch prep
- 첫 공개 버전을 `v0.x`로 태그할지 결정한다.
- changelog 또는 release notes 포맷을 정한다.
- GitHub release에 포함할 artifact와 설치 예시를 고정한다.
- 공개 직후 대응을 위해 issue labels와 pinned issue를 준비한다.

## Suggested Order

### Phase 1. 공개 경계 확정
- [x] 공개 범위(client / worker / ssh gateway)를 결정한다.
- [x] shared worker와 `pxpx.sh`를 제품 기본값으로 유지할지 결정한다.
- [x] 라이선스를 결정하고 `LICENSE`를 추가한다.

### Phase 2. 차단 요소 제거
- [x] secret scan 수행
- [x] `.gitignore` 보강
- [x] README broken link 수정
- [x] 공개용 문서 세트 추가
- [ ] `install.sh` 공개 repo slug 확정
- [x] default endpoint 정책 정리

### Phase 3. 공개 리허설
- [ ] 빈 환경에서 README만 보고 설치/실행 검증
- [ ] self-host 경로 검증
- [ ] 첫 release artifact 생성 및 설치 검증
- [ ] 공개 태그 및 저장소 visibility 변경

## Acceptance Criteria
- [ ] 저장소에 공개 불가 정보가 남아 있지 않다.
- [ ] `.env*` 및 로컬 credential 파일이 안전하게 제외된다.
- [ ] 공개 저장소 필수 문서(`LICENSE`, `CONTRIBUTING`, `SECURITY` 등)가 존재한다.
- [ ] README만으로 local 실행과 self-host 실행이 모두 가능하다.
- [ ] `install.sh`와 release artifact가 공개 저장소 slug 기준으로 동작한다.
- [ ] CI에서 최소 타입체크와 빌드가 자동 검증된다.
- [ ] shared infra 의존 여부가 README 첫 화면에서 명확하게 드러난다.

## Open Questions
- GitHub 로그인 기능을 공개 저장소 기본 기능으로 둘 것인가, self-host 전용 부가 기능으로 둘 것인가?
- npm publish까지 고려하는가, 아니면 GitHub releases 기반 binary distribution만 유지하는가?

## Immediate Next Actions
- [x] 라이선스와 공개 범위 결정
- [x] secret scan 실행
- [x] `.gitignore` 보강과 README broken link 수정
- [x] 공개용 기본 문서 세트 작성
- [ ] CI 초안 추가
