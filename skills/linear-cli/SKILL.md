---
name: linear-cli
description: Read and manage Linear issues, projects, comments, teams, documents, milestones, releases, and related workspace data through the authenticated MCPorter CLI. Use whenever the user asks to inspect, search, create, or change anything in Linear.
compatibility: Requires the local mcporter wrapper, Node.js 24 Nix shell, and an authenticated mcporter server named linear.
---

# Linear CLI

Use the local `mcporter` command. It runs MCPorter through the reusable Node.js 24 Nix shell at `~/dev/pi-agent-shells/node24-mcp` and connects to the globally configured `linear` server.

Do not install dependencies in the current project and do not add Linear configuration or credentials to a repository.

## Connection

The persistent local configuration is:

```text
~/.mcporter/mcporter.json
```

The executable wrapper is:

```text
~/.local/bin/mcporter
```

Check the connection when needed:

```bash
mcporter config get linear
mcporter call linear.get_workspace --output json
```

If authentication has expired, run:

```bash
mcporter auth linear
```

This may require the user to complete OAuth in a browser. Never read, print, copy, or commit MCPorter credential files.

## Discover tools before guessing

Linear can change its MCP tool surface. Discover current signatures rather than relying on remembered parameters:

```bash
mcporter list linear --brief
mcporter list linear --all-parameters
```

Use exact tool and parameter names from discovery. Never guess IDs, team keys, workflow-state IDs, project IDs, or enum values.

## Calling tools

Prefer JSON output for reliable parsing:

```bash
mcporter call linear.get_workspace --output json
mcporter call linear.list_issues limit=20 --output json
mcporter call linear.get_issue id=ABC-123 --output json
mcporter call linear.list_projects limit=20 --output json
```

Quote arguments containing spaces or shell-sensitive characters:

```bash
mcporter call linear.list_issues 'query=authentication bug' limit=20 --output json
```

Use bounded `limit` values and pagination cursors instead of requesting an unbounded workspace history.

## Safety policy

Read-only operations may run without additional confirmation when they directly answer the user's request. Typical read tools start with:

```text
get_
list_
search_
extract_
```

Treat these operations as consequential writes:

```text
save_
create_
delete_
resolve_
merge_
submit_
prepare_attachment_upload
```

Before a consequential write, obtain confirmation unless the user's current message explicitly requested that exact write. Confirmation should summarize the target workspace/team, operation, issue or project, and important new values.

Always confirm immediately before:

- Deleting anything
- Merging a diff
- Submitting a diff review
- Changing issue state, priority, assignee, project, or cycle when the request is ambiguous
- Bulk changes
- Creating or updating attachments

After a write, read the changed object back when practical and report its identifier and URL.

## Common workflows

### Find an issue

1. If the user supplied an issue identifier, call `linear.get_issue`.
2. Otherwise call `linear.list_issues` with a bounded query.
3. Present close matches before changing anything when the target is ambiguous.

### Create or update an issue

1. Discover `linear.save_issue` parameters.
2. Resolve the intended team and optional project/state using read tools.
3. Show the proposed title, team, description summary, and other material fields.
4. Confirm if the current user message did not explicitly request the exact write.
5. Call `linear.save_issue`.
6. Read the resulting issue back and return its identifier and URL.

`save_issue` handles both creation and update. Supplying an existing `id` changes that issue; omitting it creates one. Never omit or include `id` accidentally.

### Add a comment

1. Resolve the exact issue.
2. Show the proposed comment if it was not provided verbatim by the user.
3. Call `linear.save_comment` with `issueId` and `body`.
4. Report completion without exposing unrelated issue data.

### Group or project planning

Use `list_projects`, `get_project`, `list_milestones`, `get_milestone`, and relevant issue queries to inspect first. Do not infer authority from visibility. Being able to read an object does not itself justify changing it.

## Output discipline

- Return concise summaries rather than dumping large MCP responses.
- Preserve Linear identifiers and URLs.
- Avoid exposing unrelated users, private comments, or workspace metadata.
- Do not display access tokens, authorization URLs, headers, or credential-cache contents.
- If a tool returns an unfamiliar or destructive option, stop and ask rather than improvising.
