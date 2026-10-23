import { isToday, isYesterday, subDays, subMonths } from 'date-fns'

export interface UIChat {
  id: string
  label: string
  untitled?: boolean
  icon: string
  createdAt: string
}

export function useChats(chats: Ref<UIChat[] | undefined>) {
  const { t, intlLocale } = useLocale()
  const groups = computed(() => {
    // Group chats by date
    const today: UIChat[] = []
    const yesterday: UIChat[] = []
    const lastWeek: UIChat[] = []
    const lastMonth: UIChat[] = []
    const older: Record<string, UIChat[]> = {}

    const oneWeekAgo = subDays(new Date(), 7)
    const oneMonthAgo = subMonths(new Date(), 1)

    chats.value?.forEach((chat) => {
      const chatDate = new Date(chat.createdAt)

      if (isToday(chatDate)) {
        today.push(chat)
      } else if (isYesterday(chatDate)) {
        yesterday.push(chat)
      } else if (chatDate >= oneWeekAgo) {
        lastWeek.push(chat)
      } else if (chatDate >= oneMonthAgo) {
        lastMonth.push(chat)
      } else {
        const monthYear = `${chatDate.getFullYear()}-${String(chatDate.getMonth() + 1).padStart(2, '0')}`

        if (!older[monthYear]) {
          older[monthYear] = []
        }

        older[monthYear].push(chat)
      }
    })

    // Sort older chats by month-year in descending order (newest first)
    const sortedMonthYears = Object.keys(older).sort().reverse()

    // Create formatted groups for navigation
    const formattedGroups = [] as Array<{
      id: string
      label: string
      items: Array<UIChat>
    }>

    // Add groups that have chats
    if (today.length) {
      formattedGroups.push({
        id: 'today',
        label: t('date.today'),
        items: today
      })
    }

    if (yesterday.length) {
      formattedGroups.push({
        id: 'yesterday',
        label: t('date.yesterday'),
        items: yesterday
      })
    }

    if (lastWeek.length) {
      formattedGroups.push({
        id: 'last-week',
        label: t('date.lastWeek'),
        items: lastWeek
      })
    }

    if (lastMonth.length) {
      formattedGroups.push({
        id: 'last-month',
        label: t('date.lastMonth'),
        items: lastMonth
      })
    }

    // Add each month-year group
    sortedMonthYears.forEach((monthYear) => {
      if (older[monthYear]?.length) {
        formattedGroups.push({
          id: monthYear,
          label: new Date(`${monthYear}-01T12:00:00`).toLocaleDateString(intlLocale.value, { year: 'numeric', month: 'long' }),
          items: older[monthYear]
        })
      }
    })

    return formattedGroups
  })

  return {
    groups
  }
}
