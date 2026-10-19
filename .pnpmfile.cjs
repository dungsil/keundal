module.exports = {
  hooks: {
    readPackage(pkg) {
      // Nuxt UI's presentational chat components run without its optional AI SDK peer.
      if (pkg.name === '@nuxt/ui') {
        delete pkg.peerDependencies?.ai
        delete pkg.peerDependenciesMeta?.ai
      }
      return pkg
    }
  }
}
