module.exports = {
  hooks: {
    readPackage(pkg) {
      // Nuxt UI's presentational chat components run without its optional AI SDK peer.
      if (pkg.name === '@nuxt/ui') {
        delete pkg.peerDependencies?.ai
        delete pkg.peerDependenciesMeta?.ai
      }
      if (pkg.name === 'vite-plugin-checker') {
        delete pkg.peerDependencies?.eslint
        delete pkg.peerDependenciesMeta?.eslint
      }
      return pkg
    }
  }
}
