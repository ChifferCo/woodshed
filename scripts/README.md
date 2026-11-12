# Repository scripts

- `devConsoleApp.sh` starts/stops the dev console behind Open app.
- `prAssets.sh` publishes screenshots on the PR's asset ref without adding them to the code branch.
- `appInImage.mjs <image>` checks saved-app setup through the real session image, entrypoint, Docker launcher,
  tmux, console session API and statusd. Build `session/Dockerfile` for the public `octocat/Hello-World` sample at
  `/work/Hello-World` first; `.github/workflows/sessionApp.yml` prepares its empty dependency manifest and builds it.
  The check creates private and shared sessions with fixture credentials, stubs only model responses and personal
  settings, and never pushes or calls a paid model. It verifies start/stop before saving, clean reuse by another
  session after reopening the console store, repository precedence and retry when the console listener restarts.
  Container startup logs are printed even on failure, and all test containers and temporary files are removed.
