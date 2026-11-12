# woodshed/shared

Modules the console and the sessions both run. They import nothing outside this folder, so another tool built on
Woodshed can embed them too.

- `review/` (with its own README) and `prStatus.mjs`, which import each other: code review and a session's pull requests.
- `sessionState.mjs`: what a session's pane and transcript say it is doing.
- `terminalImages.mjs` and `devServerProcs.mjs`: which file a click in a terminal may open, and which dev servers may be
  stopped.
- `sameOrigin.mjs` and `pwa.mjs`: the known-Host and same-Origin gates, and the install-as-an-app manifest and icons.
- `isMain.mjs`: whether a script was started directly, through a symlink too.
- `project.mjs`, `yamlLite.mjs` and `projectFixture.mjs`: the project file (`.woodshed/project.yaml`), its YAML reader,
  and a full file for tests. `projectCheck.mjs` is `project.mjs check`'s checks against the checkout, and
  `workflowFile.mjs` what it and the console read from a GitHub Actions workflow. `__fixtures__/yamlLite/` holds the
  YAML reader's cases, each beside the JSON js-yaml reads it as.
- `reservedNames.mjs`: the variables, secrets and ports Woodshed keeps for itself in a session.
- `envNames.mjs`: the console's settings, each read by its `WOODSHED_` name and then by its old `WOODSHED_CLOUD_` one.

Rules:

- **Nothing here imports from outside `woodshed/shared/`.** What a module needs from its host is passed in, as
  `review/` already does with the shed's `ctx`. That keeps this folder liftable on its own.
- **It ships whole.** The shed's `install.sh` installs every `*.mjs` here to `~/woodshed/woodshed/shared/` on the box,
  and both Woodshed images copy the folder to `/opt/woodshed/shared/`. Tests, fixtures and Markdown stay behind.
- **Paths mirror the repo** on the box and in the image, so `../../../woodshed/shared/x.mjs` from the shed resolves the
  same everywhere.
- **Tests run with the shed's:** `install.sh --check` runs every `*.test.mjs` here, on the box too, and so does
  `woodshed-check.yml`. So a test here reads nothing outside this folder: one about this repo's own files belongs with
  them (`.woodshed/test/projectRepo.test.mjs` at the repo root).
