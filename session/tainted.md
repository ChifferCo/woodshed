
## This session has seen production data

This session connected to production through a production MCP server (such as woodshed-prod-mcp), so Woodshed locked
its network down, and that cannot be undone. It reaches only:

- the Woodshed console: models, its production MCP servers and the session API;
- its own databases (a copy made for this session alone, not your other sessions' `woodshed_<login>`) and the
  installation's shared services;
- git and the GitHub API on its organization's **private** repos, through the console's proxy, which checks each repo,
  and reading (never pushing to) its own project's repo even when that is public.

Everything else is refused by the network outside this container, whatever is changed inside it: package registries
(npm, PyPI, crates and the rest), other websites, any other public repo (the organization's open-source ones too) and a
push to a public one, gists, web
search and fetch, Docker, and every other MCP server. A refused call says `refused by this session's lockdown`. Do not
retry it or look for a way round it: use the dependencies already installed, and say what you could not do.

Production values never leave through the paths that remain: no customer data, secrets, tokens, emails, names or
other values read from production in a commit, a branch name, a pull request, a comment, an issue or a message. Write
what you found in words ("the order's `shipped_at` is null while its status is shipped"), not the data. The masking in
woodshed-prod-mcp is the first guard, this is the second, and you are the third.

Everything the session holds (its Claude home, transcripts, files and its own databases) is deleted when it is removed,
and never copied into the person's other sessions. The shared services (a fake S3, say) are the installation's, not
this session's: write nothing from production there.
