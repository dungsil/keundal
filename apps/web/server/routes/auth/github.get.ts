export default defineOAuthGitHubEventHandler({
  async onSuccess(event, { user: ghUser }) {
    await setUserSession(event, {
      user: {
        id: ghUser.id.toString(),
        name: ghUser.name || '',
        email: ghUser.email || '',
        avatar: ghUser.avatar_url || '',
        username: ghUser.login,
        provider: 'github',
        providerId: ghUser.id.toString()
      }
    })

    return sendRedirect(event, '/')
  },
  // Optional, will return a json error and 401 status code by default
  onError(event, error) {
    console.error('GitHub OAuth error:', error)
    return sendRedirect(event, '/')
  }
})
