# @keundal/ui-slots

UI 플러그인이 Vue 컴포넌트를 등록하는 슬롯 레지스트리입니다. Cordis 서비스 `ctx.slots`와 렌더링 컴포넌트를 제공합니다.

- `ctx.slots.register(options, Component)`: 선언된 슬롯에 컴포넌트를 등록하고, `children`에 적은 하위 슬롯을 선언합니다.
- `ctx.slots.inject(name, callback)`: 다른 플러그인이 선언하는 슬롯에 선언이 생길 때마다 등록합니다.
- `ctx.slots.registerFactory(options, Component)`: 어느 항목에서나 그릴 수 있는 팩터리를 등록합니다.
- `SlotRoot`, `SlotOutlet`, `SlotFactory`: 슬롯과 팩터리를 그립니다. 항목은 자신이 선언한 슬롯만 그릴 수 있습니다.
- `useSlotEntries(name)`: 선언한 슬롯의 항목 메타데이터를 읽습니다.

등록과 선언은 등록한 플러그인의 수명을 따릅니다. 항목을 해제하면 그 항목이 선언한 하위 슬롯과 그 안의 항목도 함께 해제됩니다. 슬롯 이름과 소유자 값의 타입은 `SlotMap`과 `FactoryMap`에 선언 병합합니다.

규칙과 슬롯 구조는 [UI 플러그인 문서](../../docs/ui-plugins.md)를 참고합니다.
