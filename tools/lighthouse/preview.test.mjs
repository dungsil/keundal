import assert from 'node:assert/strict'
import test from 'node:test'

import { findPreview } from './preview.mjs'

const sha = 'a'.repeat(40)
const url = 'https://pr-140-keundal-web.dungsil.workers.dev'
const comment = {
  user: { login: 'github-actions[bot]' },
  body: `[웹 프리뷰 열기](${url})\n커밋: \`${sha}\`\n<!-- Sticky Pull Request Commentcloudflare-preview -->`
}

test('현재 커밋의 배포 댓글에서 프리뷰 주소를 가져온다', () => {
  assert.equal(findPreview([comment], sha), url)
})
test('이전 커밋이나 사용자가 작성한 댓글은 사용하지 않는다', () => {
  assert.equal(findPreview([comment], 'b'.repeat(40)), undefined)
  assert.equal(findPreview([{ ...comment, user: { login: 'someone' } }], sha), undefined)
})
test('다른 서버나 자격 증명이 포함된 주소는 사용하지 않는다', () => {
  for (const target of ['https://example.com', 'https://user:pass@x.workers.dev', 'https://x.workers.dev.evil.com']) {
    assert.equal(findPreview([{ ...comment, body: comment.body.replace(url, target) }], sha), undefined)
  }
})
