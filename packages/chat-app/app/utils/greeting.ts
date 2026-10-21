export function getGreetingTime(hour = new Date().getHours()) {
  return hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'
}

export const greetingTimeScript = `document.documentElement.dataset.greetingTime = (${getGreetingTime.toString()})()`
