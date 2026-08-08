# Publishing custos-mcp

## Version bumping

Bump both packages together — the wire format is versioned separately (`spec/WIRE.md` §1 `v` field). Regular releases only bump semver on the packages.

```bash
# packages/custos-py/pyproject.toml → version = "X.Y.Z"
# packages/custos-js/package.json  → "version": "X.Y.Z"
# CHANGELOG.md
git commit -am "release: vX.Y.Z"
git tag vX.Y.Z && git push --tags
gh release create vX.Y.Z --generate-notes
```

The `.github/workflows/publish.yml` workflow triggers on the release and publishes to both registries.

## Manual first-time publish

### PyPI

```bash
cd packages/custos-py
pip install build twine
python -m build                      # produces dist/*.whl and dist/*.tar.gz
python -m twine check dist/*         # sanity-check metadata
python -m twine upload dist/*        # prompts for API token
```

Store an API token at https://pypi.org/manage/account/token/ and either put it in `~/.pypirc` or paste it interactively.

### npm

```bash
cd packages/custos-js
npm login                            # once per machine
npm run build
npm pack --dry-run                   # inspect what will ship
npm publish --access public          # first publish
```

## Trusted Publisher (recommended for future releases)

- **PyPI:** register `sanjaynandanj/custos` at https://pypi.org/manage/account/publishing/ so tags trigger publish without a stored token.
- **npm:** add `NPM_TOKEN` (an automation token from https://www.npmjs.com/settings/YOU/tokens) as a repo secret; the workflow already reads it.
