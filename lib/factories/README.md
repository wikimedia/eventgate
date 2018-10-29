Modules here are all expected to export a `factory()` method that takes an
Express `app.conf` object as the first argument.  `factory()` in modules that end in
`-eventbus` should return a Promise of an instantiated `Eventbus`.