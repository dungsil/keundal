export default defineAppConfig({
  ui: {
    button: {
      compoundVariants: [
        {
          color: 'primary',
          variant: 'solid',
          class: 'hover:bg-primary-700 active:bg-primary-700 dark:hover:bg-primary-300 dark:active:bg-primary-300'
        }
      ]
    },
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
