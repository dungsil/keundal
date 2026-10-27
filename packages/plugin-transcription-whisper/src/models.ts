import type { SpeechModel } from '@keundal/transcription'

const CATALOG_ROOT = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'

/** whisper.cpp가 읽는 ggml 모델 목록입니다. 크기는 대략적인 값입니다. */
export const speechModels: readonly SpeechModel[] = [
  { id: 'tiny', label: 'Tiny', url: `${CATALOG_ROOT}/ggml-tiny.bin`, bytes: 77_700_000 },
  { id: 'small', label: 'Small', url: `${CATALOG_ROOT}/ggml-small.bin`, bytes: 487_600_000 },
  { id: 'medium', label: 'Medium', url: `${CATALOG_ROOT}/ggml-medium.bin`, bytes: 1_533_000_000 },
  { id: 'large-v3', label: 'Large v3', url: `${CATALOG_ROOT}/ggml-large-v3.bin`, bytes: 3_094_000_000 },
  {
    id: 'large-v3-turbo-q5_0',
    label: 'Large v3 Turbo (Compressed)',
    url: `${CATALOG_ROOT}/ggml-large-v3-turbo-q5_0.bin`,
    bytes: 574_000_000
  }
]

/** 압축 모델은 정확도 손실이 작고 크기가 절반 이하라 기본값으로 씁니다. */
export const defaultSpeechModel = 'large-v3-turbo-q5_0'

export function findSpeechModel(id: string): SpeechModel | undefined {
  return speechModels.find((model) => model.id === id)
}
