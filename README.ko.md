# Pixel Game

터미널에서 실행하는 실시간 협업 픽셀 보드입니다. 이 저장소에는 터미널 클라이언트, Cloudflare Worker 서버, 로컬 빌드와 릴리스 스크립트가 포함되어 있습니다.

전체 설치와 운영 문서는 [README.md](./README.md)를 참고하세요. 이 문서는 발표나 빠른 공유를 위한 짧은 한국어 개요입니다.

## 공개 범위

- 기본 공개 범위: 터미널 클라이언트, Cloudflare Worker, 로컬 빌드와 릴리스 스크립트
- 고급 옵션: SSH gateway
- 기본 정책: maintainer가 운영하는 shared 서버에 의존하지 않고 self-host 또는 로컬 실행 기준

## 빠른 시작

의존성 설치:

```bash
pnpm install
```

로컬 협업 서버 실행:

```bash
pnpm dev:server
```

클라이언트 실행:

```bash
pnpm dev:client
```

기본 연결 주소는 `ws://127.0.0.1:1234`이고 기본 방 이름은 `pixel-game`입니다.

호스팅된 SSH 진입점이 열려 있다면 특정 GitHub 레포 방으로 바로 들어갈 수도 있습니다:

```bash
ssh pxpx.sh
ssh -t pxpx.sh torvalds/linux
```

## Worker 기능 사용

로컬 Worker 실행:

```bash
pnpm dev:server:cloudflare
```

게임플레이와 로그인 연결:

```bash
PIXEL_SERVER_URL=ws://127.0.0.1:8787 pnpm dev:client
PIXEL_AUTH_SERVER_URL=ws://127.0.0.1:8787 pnpm dev:client -- login
```

## 주요 특징

- 여러 사용자가 같은 보드에서 동시에 그림 가능
- `owner/repo` 형식의 GitHub 저장소 단위 방 지원
- GitHub 로그인과 보호된 저장소 방 지원
- 단독 실행 가능한 바이너리 빌드와 GitHub release 패키징 지원

## 관련 문서

- [기여 가이드](./CONTRIBUTING.md)
- [보안 정책](./SECURITY.md)
- [전체 영문 README](./README.md)
