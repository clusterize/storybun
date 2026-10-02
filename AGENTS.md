# Instructions for AI agents

## This is a PUBLIC repository

Never mention **clusterize** anywhere that is published with this repository:
not in code comments, commit messages, PR titles or descriptions, issue titles
or bodies, review comments, changelogs, docs, test names or fixtures.

The name refers to a private, unrelated project that happens to use this tool.
Nothing about it (its stories, components, file counts, pixel diffs, workflow,
bugs it hit) may leak here. Describe such things generically instead, e.g.
"a downstream app", "a consumer that supplies its own Wrapper", "one real-world
project with ~190 stale baselines".

The **only** permitted occurrence is the literal GitHub slug in the repository
and action path (`clusterize/storybun`, `uses: clusterize/storybun@v1`), because
that is simply this repo's address.

Before committing or opening a PR, grep your diff and your message for the
word (case-insensitive) and remove every hit that is not that slug.
