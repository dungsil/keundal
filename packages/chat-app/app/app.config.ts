export default defineAppConfig({
  ui: {
    chatMessage: {
      slots: {
        actions: 'focus-within:opacity-100'
      }
    },
    // Nuxt UI 기본값인 text-dimmed는 입력란 배경에서 2.5:1이라 안내 문구를 읽기 어렵다.
    input: {
      slots: {
        base: 'placeholder:text-muted'
      }
    },
    textarea: {
      slots: {
        base: 'placeholder:text-muted'
      }
    },
    colors: {
      primary: 'blue',
      neutral: 'zinc'
    }
  }
})
