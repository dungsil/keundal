export function resampleAudio(input: Float32Array, from: number, to = 24000): Float32Array {
  if (!(from > 0 && to > 0)) throw new Error('Invalid sample rate')
  const output = new Float32Array(Math.round((input.length * to) / from))
  for (let i = 0; i < output.length; i++) {
    const position = (i * from) / to
    const left = Math.floor(position)
    const fraction = position - left
    output[i] = (input[left] ?? 0) * (1 - fraction) + (input[Math.min(left + 1, input.length - 1)] ?? 0) * fraction
  }
  return output
}
