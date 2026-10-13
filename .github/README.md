# Package releases

Pushes to `main` run tests and publish to GitHub Packages using `GITHUB_TOKEN`.

- A commit subject starting with `release:` publishes its committed version without another bump
- Other commits generate a patch above the highest stable source or registry version, commit both npm manifests as `release: <version>`, and push that commit before publishing
- Tags point to the versioned source commit, not the original triggering commit
- Bot pushes using `GITHUB_TOKEN` do not trigger another push workflow
- Releases are serialized without cancelling an active publication; queued runs check out current `main`, so closely spaced pushes can share one release
- Failed reconciliation pushes abort publication; no force pushes are used
- Reruns skip a published version only when registry `gitHead` matches the source, then repair a missing tag

The existing package must grant this repository write access under **Package settings → Manage Actions access**. Repository rules must permit the workflow to push release commits to `main` and create `v*` tags. No personal access token is needed.

For a manual major/minor release, update `package.json` and `package-lock.json` and use a `release:` commit subject. This workflow requires an existing package; registry lookup failures stop the release rather than guessing a version.

Publication and Git updates are not atomic. If publishing fails after the bump commit, rerun the workflow while that commit is still current. If tagging fails after publishing, the same rerun verifies the published source before creating the tag. Later source commits do not automatically repair older missing tags.
