# woodshed/.woodshed

Woodshed's own Woodshed files: how a session works on Woodshed. The same shape as the `.woodshed/` at the root of the
repo Woodshed is in, which is where these go when `woodshed/` becomes a repo of its own.

To run Woodshed on your machine, use the local provider (`providers/local/README.md`): a console with none of its
settings but `WOODSHED_PROVIDER=local` runs sessions in Docker and nothing else.

| File | What it is |
| --- | --- |
| `project.yaml`, `rules.md` | The project file for Woodshed: no dependencies, no databases, no app; checks with `node --test` and the dev console. Nothing reads it while Woodshed is inside another repo, where sessions read that repo's; `test/selfProject.test.mjs` keeps it valid |
