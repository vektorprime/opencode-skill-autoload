---
name: git-workflow
description: Use for any git work - committing, branching, rebasing, squashing commits, resolving merge conflicts, undoing mistakes and pushing to GitHub.
---

# Git workflow

## Committing

Check what changed with `git status` and `git diff` before staging. Stage files explicitly with
`git add <path>` rather than `git add -A`, and write a short imperative subject line. Use
`git commit --amend` only for the latest commit and only before it has been pushed.

## Branches

Create a branch per task with `git switch -c feature/name`. Keep branches short-lived and rebase
them on the main branch before opening a pull request. Delete merged branches locally with
`git branch -d` and on the remote with `git push origin --delete`.

## Rebasing and squashing commits

To squash the last N commits, run `git rebase -i HEAD~N`, keep the first line as `pick` and mark the
others as `squash` or `fixup`. After rewriting history that was already pushed, update the remote
with `git push --force-with-lease`, never a plain `--force`. Use `git rebase --onto` to move a range
of commits to a different base.

## Merge conflicts

When a merge or rebase stops on conflicts, open each conflicted file, keep the right side of every
conflict block, remove the markers, then `git add` the file and continue with `git rebase --continue`
or `git merge --continue`. Abort with `git rebase --abort` if the result looks wrong.

## Pushing and pull requests

Push a new branch with `git push -u origin <branch>`. Open pull requests with `gh pr create`, fill in
a summary and testing notes, and request reviewers.

## Undoing mistakes

`git reflog` lists every position HEAD has been at, so a lost commit can be recovered with
`git reset --hard <sha>`. Undo the last commit but keep its changes with `git reset --soft HEAD~1`.
Revert a pushed commit with `git revert <sha>` instead of rewriting shared history.
