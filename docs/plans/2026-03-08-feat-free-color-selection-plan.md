---
title: "feat: Enable Free Color Selection"
type: feat
status: completed
date: 2026-03-08
---

# ✨ feat: Enable Free Color Selection

## Enhancement Summary

**Deepened on:** 2026-03-08  
**Sections enhanced:** 7  
**Research agents/skills used:** `deepen-plan`, `best-practices-researcher`, `framework-docs-researcher`, `spec-flow-analyzer`, `performance-oracle`, `security-sentinel`, `kieran-typescript-reviewer`, `julik-frontend-races-reviewer`

### Key Improvements
1. 색상 데이터 모델을 `legacy palette id + hex` 이중 호환으로 명확화해 무중단 전환 전략을 구체화함.
2. 입력 모드 상태머신(Idle/InputEditing/Applying/Invalid)을 명시해 키 충돌/레이스 리스크를 줄이는 실행 가이드를 추가함.
3. 공식 문서 기반으로 입력 제어, Yjs 변경 관찰, 접근성 대비 기준을 계획의 품질 게이트로 포함함.

### New Considerations Discovered
- React controlled input 규칙을 어기면 입력 안정성 저하 가능성이 있어 입력 모드 상태를 단일 소스로 강제해야 함.
- Yjs `Y.Map.observe`는 동기 호출이므로 observer 내부 갱신 루프를 피하도록 side effect 경계를 명확히 해야 함.

## Section Manifest
- Section 1: Overview/Problem - 사용자 가치와 현행 제약 근거 보강
- Section 2: Proposed Solution - 데이터 호환/입력 UX/검증 규칙 상세화
- Section 3: Technical/System Impact - 성능/보안/에러 전파/레이스 분석 강화
- Section 4: SpecFlow & Acceptance - 누락 플로우와 품질 게이트 정밀화
- Section 5: Implementation Notes - 파일 단위 작업을 단계/테스트 시나리오와 연결

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

### Research Insights

**Best Practices:**
- 입력 UI는 React controlled 패턴(`value` + 동기 `onChange`)으로 유지하고 controlled/uncontrolled 전환을 금지합니다.
- 데이터 호환은 write는 신규 포맷(HEX), read는 구포맷+신규포맷 모두 지원하는 점진 전환 방식을 사용합니다.
- 사용자 입력은 적용 전 정규화(`trim -> lowercase`)하고 유효하지 않으면 상태를 유지한 채 오류만 노출합니다.

**Implementation Details:**
```ts
// src/client.tsx
type PaintColorValue = string; // "rose" (legacy) | "#a1b2c3" (new)

function normalizeHex(input: string): string | null {
  const raw = input.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(raw) ? raw : null;
}

function resolvePaintHex(value: PaintColorValue | undefined): string {
  if (!value) return EMPTY_CELL_COLOR;
  if (COLOR_BY_ID[value]) return COLOR_BY_ID[value].hex;
  return normalizeHex(value) ?? EMPTY_CELL_COLOR;
}
```

**Edge Cases:**
- `#abc`/`#RRGGBBAA` 등 비지원 형식 입력 시 무시하고 메시지로 피드백.
- 입력 모드 중 `1-8`/`Enter`가 페인트로 처리되지 않도록 key routing 분리.
- 동일 셀 동일 색 재페인트는 기존 최적화(`already uses`) 유지.

## Technical Considerations
- Architecture impacts:
  - 색상 식별자가 ID에서 HEX 중심으로 변경되므로 표시 함수(`getColorHex`, `getPaintLogLabel`, `getPaintLogTextColor`) 보강 필요
- Performance implications:
  - 문자열 검증/정규화는 경량이며 렌더 루프 성능 영향 미미
- Security considerations:
  - 입력값은 로컬 키 입력만 처리, HTML 렌더링 경로 없음
  - 비정상 문자열이 Yjs 상태를 오염시키지 않도록 strict validation 필요

### Research Insights

**Performance Considerations:**
- `useDeferredValue`는 무거운 하위 렌더의 반응성을 지키는 용도이며, 색상 입력 자체에는 과도하게 적용하지 않고 보드 스냅샷 경로에만 유지하는 것이 안전합니다.
- 색상 resolver는 모든 셀 렌더 경로에서 호출되므로 O(1) 맵 조회 + 단순 정규식만 허용합니다.

**Security Considerations:**
- 허용 입력을 `#RRGGBB`로 제한하면 예상치 못한 escape sequence/긴 문자열 주입을 차단할 수 있습니다.
- Yjs write 전 validation을 강제하고, invalid 값은 로컬 상태에서도 커밋하지 않도록 합니다.

**Quality Bar (TypeScript):**
- `any` 없이 `PaintColorValue` 타입을 도입해 legacy/new 포맷을 명시적으로 관리합니다.
- 파싱/정규화/표시 함수를 분리해 테스트 가능성과 가독성을 높입니다.

## System-Wide Impact
- **Interaction graph**: 키 입력(`useKeyboard`) → 색상 선택 상태 업데이트 → `attemptPlacement`에서 `pixelsMap` 기록 → 보드 렌더/paint log/원격 tint 반영
- **Error propagation**: 잘못된 HEX 입력은 입력 처리 레벨에서 즉시 차단하고 `setStatusMessage`로 종료, 데이터 계층까지 전파 금지
- **State lifecycle risks**: 색상 모델 전환 중 기존 `colorId` 해석 누락 시 과거 픽셀이 빈칸처럼 보일 위험
- **API surface parity**: 키보드 선택(1-8), 마우스 페인트, status/pain log/remote cursor 모두 동일 색상 표현 규칙 적용 필요
- **Integration test scenarios**:
  - 기존 팔레트 ID 픽셀이 있는 룸 접속 시 정상 표시
  - 커스텀 HEX로 페인트 후 다른 클라이언트에서 동일 색상 동기화 확인
  - 잘못된 HEX 입력 후 상태 오염 없이 이전 색상 유지 확인

### Research Insights

**Race/Timing Hardening:**
- 입력 모드 상태를 `IDLE | EDITING_CUSTOM_COLOR | APPLYING`로 고정하고, 모드별 허용 키만 처리합니다.
- 비동기 처리(예: 상태 메시지 타이머)를 추가할 경우 취소 가능 구조를 강제해 stale update를 방지합니다.

**Error Propagation Rule:**
- Validation 실패는 UI layer에서 종결하고 CRDT mutation(`pixelsMap.set`)까지 전달하지 않습니다.
- 관찰자(`ymap.observe`) 내부에서 다시 map write를 유발하는 패턴은 루프 위험이 있어 금지합니다.

## SpecFlow Analysis (Gap & Edge Cases)
1. 입력 모드 충돌: 커스텀 입력 중 이동/페인트 키를 누르면 의도치 않은 동작 가능
- 대응: 입력 모드에서는 입력 관련 키만 처리하고 나머지 단축키 잠금

2. 색상 라벨 가시성: HEX 직접 사용 시 `Selected: ...`와 paint log 라벨이 너무 길거나 난해할 수 있음
- 대응: `Custom (#a1b2c3)` 형식으로 요약 라벨 제공

3. 기존 데이터 호환성: 이전 룸 데이터가 palette ID만 갖고 있는 상태
- 대응: resolver 함수에서 `palette id -> hex` 매핑 우선, 실패 시 fallback color 적용

4. 사용자 피드백 부족: 유효하지 않은 입력 시 왜 실패했는지 불명확
- 대응: 상태바 메시지에 허용 포맷을 명시 (`Invalid color. Use #RRGGBB.`)

### Research Insights

**Additional Flow Gaps Found:**
- 최초 실행 시 custom color 초기값 정책 미정: 기본값을 현재 선택 팔레트 HEX로 동기화할지 빈 문자열로 시작할지 결정 필요.
- 입력 취소(`Esc`) 시 이전 선택색 유지 여부와 상태 메시지 정책 필요.
- 접근성: 밝은 배경색 선택 시 텍스트 대비가 낮아질 수 있어 셀 라벨/커서 표식 가독성 룰이 필요.

**Recommended Defaults:**
- 입력 모드 진입 시 현재 선택 HEX를 프리필.
- `Esc` 취소 시 색상 미변경 + `"Custom color edit canceled"` 메시지 표시.
- 셀 오버레이 텍스트 색상은 현재 `getReadableTextColor`를 강제 적용하고 최소 대비 기준을 테스트 항목에 포함.

## Acceptance Criteria
- [ ] 사용자가 고정 팔레트 외 임의 HEX 색상(`#RRGGBB`)을 입력해 페인팅할 수 있다. (`src/client.tsx`)
- [ ] 기존 `1-8` 단축키 팔레트 선택은 그대로 동작한다. (`src/client.tsx`, `README.md`)
- [ ] 기존 룸 데이터(팔레트 ID 기반)가 마이그레이션 없이 정상 렌더된다. (`src/client.tsx`)
- [ ] 유효하지 않은 색상 입력은 저장/전송되지 않으며 사용자에게 오류 메시지가 표시된다. (`src/client.tsx`)
- [ ] 커스텀 색상으로 칠한 결과가 다중 클라이언트 간 동일하게 동기화된다. (`src/client.tsx`)
- [ ] 조작 안내 문구가 실제 키 바인딩/입력 흐름과 일치하도록 문서가 업데이트된다. (`README.md`)

### Research Insights

**Quality Gates (추가):**
- [ ] 입력 모드에서 페인트/이동 단축키가 비활성화됨을 수동 시나리오로 검증한다.
- [ ] legacy `colorId` 데이터가 섞인 room에서 화면/로그 라벨 회귀가 없음을 검증한다.
- [ ] 커스텀 색상 100회 연속 입력/적용 후 프레임 저하 또는 상태 꼬임이 없는지 확인한다.

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
- [x] `src/client.tsx`: 색상 상태를 HEX 중심으로 재구성하고 팔레트/커스텀 동시 지원
- [x] `src/client.tsx`: `ColorPalette` 영역에 custom color 입력 UI/상태 메시지 추가
- [x] `src/client.tsx`: legacy palette id + hex resolver 유틸 추가
- [x] `src/client.tsx`: paint log 라벨/텍스트 색상 처리 보강
- [x] `README.md`: Controls 섹션에 custom color 입력 방법 추가

### Research Insights

**Phased Execution (권장):**
1. 데이터 계층 분리: resolver/validator 유틸 먼저 도입 후 기존 경로 대체.
2. 입력 UX 추가: custom 입력 모드와 key routing 구현.
3. 표시/로그 정합성: 셀 렌더/paint log/selected label 동시 반영.
4. 문서/검증: README 및 수동 테스트 시나리오 확정.

**Manual Test Matrix (요약):**
- 단일 클라이언트: 팔레트 선택, custom 적용, invalid 입력, 취소.
- 다중 클라이언트: A가 custom 페인트, B 표시/로그/커서 tint 확인.
- 혼합 데이터: 기존 palette-id room과 신규 hex room 각각 접속 확인.

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
- External references (2026-03-08 확인):
  - React `useDeferredValue`: https://react.dev/reference/react/useDeferredValue
  - React `<input>` controlled guidance: https://react.dev/reference/react-dom/components/input
  - Yjs `Y.Map` API: https://docs.yjs.dev/api/shared-types/y.map
  - MDN `<hex-color>`: https://developer.mozilla.org/en-US/docs/Web/CSS/hex-color
  - WCAG 2.1 Contrast Minimum: https://www.w3.org/TR/WCAG21/#contrast-minimum
