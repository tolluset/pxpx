---
title: "feat: Enable Free Color Selection"
type: feat
status: active
date: 2026-03-08
---

# ✨ feat: Enable Free Color Selection

## Overview
현재 클라이언트는 고정 팔레트 8색만 선택 가능하며(`1-8`), 페인팅 데이터는 `colorId`를 Yjs `pixels` 맵에 저장합니다. 이 이슈는 기존 고정 색상 UX를 유지하면서 사용자가 임의의 HEX 색상을 직접 입력/선택해 칠할 수 있도록 확장합니다.

## Problem Statement / Motivation
- 사용자 요구: “현재 고정 색만 가능한데 자유 색 지정 가능하게”
- 현재 제약:
  - 팔레트가 상수로 고정되어 있음 (`src/client.tsx:875`)
  - 단축키도 고정 팔레트 ID 기반 (`src/client.tsx:1623`)
  - 사이드바 안내 문구도 `1-8 selects color`로 고정 (`src/client.tsx:1975`, `README.md:245`)
- 결과적으로 커스텀 색상 사용, 브랜딩 색 매칭, 미세 색감 표현이 불가능함

## Research Summary
### Local Repo Findings
- 색상 모델은 `PaletteColor { id, name, hex, hotkey }` 기반이며 전역 `PALETTE` + `COLOR_BY_ID`로 렌더링/상태/로그가 연결됨 (`src/client.tsx:875-890`).
- 선택 상태는 `selectedColorId`이며 기본값은 `PALETTE[0].id` (`src/client.tsx:1305`).
- 페인팅 시 `pixelsMap.set(cellKey, selectedColorId)`로 저장 (`src/client.tsx:1499`).
- UI 팔레트 컴포넌트는 현재 고정 목록 렌더링만 지원 (`src/client.tsx:1205-1228`).
- 원격 커서 tint는 HEX 직접 사용 가능 구조 (`provider.awareness`의 `cursor.color`) (`src/client.tsx:1680-1684`).

### Institutional Learnings
- `docs/solutions/` 및 `docs/solutions/patterns/critical-patterns.md` 부재로 참고 가능한 축적 솔루션 없음.
- 따라서 기존 코드 패턴과 보수적 변경(하위호환 우선)을 기준으로 계획 수립.

### External Research Decision
- 주제는 외부 결제/보안/서드파티 API 리스크가 없는 로컬 UI/상태 확장 작업.
- 저장소 내 구현 맥락이 충분히 명확하여 외부 리서치 생략.

## Proposed Solution
고정 팔레트 기반 구조를 유지하되 “Custom 색상 슬롯”을 추가해 자유 색상을 안전하게 선택/저장하도록 확장합니다.

1. `selectedColorId` 중심 모델을 `selectedPaintColorHex` 중심으로 전환
- 기존 팔레트 선택도 최종적으로는 HEX 값 선택으로 매핑
- 커스텀 입력 시 별도 ID 생성 없이 HEX 자체를 단일 소스 오브 트루스로 사용

2. 하위호환 가능한 픽셀 데이터 처리
- 기존 보드에 저장된 팔레트 ID(예: `rose`)는 계속 해석 가능해야 함
- 신규 페인트는 HEX 문자열로 저장
- `getColorHex`/`currentCellColor`/paint log 라벨 처리 시 `palette id | hex` 모두 지원

3. TUI 입력 UX 추가
- 사이드바에 `Custom color` 섹션 추가 (`#RRGGBB` 입력 상태 표시)
- 키 바인딩 예시:
  - `C`: custom color 입력 모드 진입/해제
  - 입력 모드에서 HEX 문자열 편집 후 `Enter` 적용, `Esc` 취소
- 기존 `1-8` 단축키 동작은 유지

4. 검증/정규화
- 허용 포맷: `#RRGGBB` (필수), 소문자 정규화
- 유효하지 않은 값은 적용 거부 + status 메시지 표시

## Technical Considerations
- Architecture impacts:
  - 색상 식별자가 ID에서 HEX 중심으로 변경되므로 표시 함수(`getColorHex`, `getPaintLogLabel`, `getPaintLogTextColor`) 보강 필요
- Performance implications:
  - 문자열 검증/정규화는 경량이며 렌더 루프 성능 영향 미미
- Security considerations:
  - 입력값은 로컬 키 입력만 처리, HTML 렌더링 경로 없음
  - 비정상 문자열이 Yjs 상태를 오염시키지 않도록 strict validation 필요

## System-Wide Impact
- **Interaction graph**: 키 입력(`useKeyboard`) → 색상 선택 상태 업데이트 → `attemptPlacement`에서 `pixelsMap` 기록 → 보드 렌더/paint log/원격 tint 반영
- **Error propagation**: 잘못된 HEX 입력은 입력 처리 레벨에서 즉시 차단하고 `setStatusMessage`로 종료, 데이터 계층까지 전파 금지
- **State lifecycle risks**: 색상 모델 전환 중 기존 `colorId` 해석 누락 시 과거 픽셀이 빈칸처럼 보일 위험
- **API surface parity**: 키보드 선택(1-8), 마우스 페인트, status/pain log/remote cursor 모두 동일 색상 표현 규칙 적용 필요
- **Integration test scenarios**:
  - 기존 팔레트 ID 픽셀이 있는 룸 접속 시 정상 표시
  - 커스텀 HEX로 페인트 후 다른 클라이언트에서 동일 색상 동기화 확인
  - 잘못된 HEX 입력 후 상태 오염 없이 이전 색상 유지 확인

## SpecFlow Analysis (Gap & Edge Cases)
1. 입력 모드 충돌: 커스텀 입력 중 이동/페인트 키를 누르면 의도치 않은 동작 가능
- 대응: 입력 모드에서는 입력 관련 키만 처리하고 나머지 단축키 잠금

2. 색상 라벨 가시성: HEX 직접 사용 시 `Selected: ...`와 paint log 라벨이 너무 길거나 난해할 수 있음
- 대응: `Custom (#a1b2c3)` 형식으로 요약 라벨 제공

3. 기존 데이터 호환성: 이전 룸 데이터가 palette ID만 갖고 있는 상태
- 대응: resolver 함수에서 `palette id -> hex` 매핑 우선, 실패 시 fallback color 적용

4. 사용자 피드백 부족: 유효하지 않은 입력 시 왜 실패했는지 불명확
- 대응: 상태바 메시지에 허용 포맷을 명시 (`Invalid color. Use #RRGGBB.`)

## Acceptance Criteria
- [ ] 사용자가 고정 팔레트 외 임의 HEX 색상(`#RRGGBB`)을 입력해 페인팅할 수 있다. (`src/client.tsx`)
- [ ] 기존 `1-8` 단축키 팔레트 선택은 그대로 동작한다. (`src/client.tsx`, `README.md`)
- [ ] 기존 룸 데이터(팔레트 ID 기반)가 마이그레이션 없이 정상 렌더된다. (`src/client.tsx`)
- [ ] 유효하지 않은 색상 입력은 저장/전송되지 않으며 사용자에게 오류 메시지가 표시된다. (`src/client.tsx`)
- [ ] 커스텀 색상으로 칠한 결과가 다중 클라이언트 간 동일하게 동기화된다. (`src/client.tsx`)
- [ ] 조작 안내 문구가 실제 키 바인딩/입력 흐름과 일치하도록 문서가 업데이트된다. (`README.md`)

## Success Metrics
- 기능 지표: 커스텀 색상 페인팅 성공률 100% (수동 시나리오 기준)
- 호환성 지표: 기존 팔레트 데이터 렌더 회귀 0건
- UX 지표: 잘못된 입력 시 즉시 오류 메시지 노출 100%

## Dependencies & Risks
- Dependencies:
  - 클라이언트 단일 파일 중심 변경 (`src/client.tsx`)
  - 컨트롤 문서 갱신 (`README.md`)
- Risks:
  - 색상 표현 로직 분산으로 일부 경로 미반영 가능성
  - 입력 모드 추가로 키 처리 복잡성 증가
- Mitigation:
  - 색상 해석을 단일 resolver 함수로 통합
  - 키 처리 분기 테스트 시나리오를 문서화하고 수동 검증

## Implementation Notes
### Suggested file-level tasks
- [ ] `src/client.tsx`: 색상 상태를 HEX 중심으로 재구성하고 팔레트/커스텀 동시 지원
- [ ] `src/client.tsx`: `ColorPalette` 영역에 custom color 입력 UI/상태 메시지 추가
- [ ] `src/client.tsx`: legacy palette id + hex resolver 유틸 추가
- [ ] `src/client.tsx`: paint log 라벨/텍스트 색상 처리 보강
- [ ] `README.md`: Controls 섹션에 custom color 입력 방법 추가

### Pseudo code sketch
#### src/client.tsx
```ts
function resolvePaintHex(raw: string | undefined): string {
  if (!raw) return EMPTY_CELL_COLOR;
  if (COLOR_BY_ID[raw]) return COLOR_BY_ID[raw].hex; // legacy palette id
  if (isValidHexColor(raw)) return normalizeHex(raw); // new format
  return EMPTY_CELL_COLOR;
}
```

## AI-Era Considerations
- AI pair 프로토타이핑 시 키 이벤트 분기 누락 가능성이 높아 최종 human review 포인트를 명시:
  - 입력 모드 on/off 전이
  - legacy 데이터 호환 resolver
  - status message 정확성
- 구현 속도보다 회귀 방지(동기화/렌더/로그) 테스트를 우선

## Sources & References
- Similar implementations:
  - `src/client.tsx:875` (고정 PALETTE 정의)
  - `src/client.tsx:1205` (`ColorPalette` 컴포넌트)
  - `src/client.tsx:1305` (`selectedColorId` 상태)
  - `src/client.tsx:1470` (`attemptPlacement` 페인트 기록)
  - `src/client.tsx:1623` (숫자 hotkey 색상 선택)
  - `src/client.tsx:1975` (컨트롤 가이드 텍스트)
- Documentation:
  - `README.md:245` (현재 색상 선택 키 설명)
- Related docs:
  - `docs/2026-03-07-pixel-game-plan.md`
