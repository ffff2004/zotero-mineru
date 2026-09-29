## Rules

- When the content in this `AGENTS.md` or other documents becomes outdated, update it.
- Documents describe current implementation, not future outcomes.
- Keep changing task state and verification results in PR/CI rather than maintaining an in-repository copy.
- Use Conventional Commits.
- Do not disable git hooks if there is.

## Project Structure

Zotero MinerU is a TypeScript/ES module plugin based on Zotero Plugin Template.
The current runtime contains template examples; MinerU integration is not yet
implemented.

```text
./
|-- src/                     # TypeScript plugin code
|   |-- index.ts             # Plugin entrypoint
|   |-- addon.ts             # Plugin state and API
|   |-- hooks.ts             # Lifecycle and event handlers
|   |-- modules/             # Feature modules and template examples
|   |-- utils/               # Shared utilities
|-- addon/                   # Bootstrap, manifest, UI, locales, and assets
|-- typings/                 # Global TypeScript declarations
|-- test/                    # Tests running inside Zotero
|-- doc/                     # Translated template documentation
|-- package.json             # Plugin identity, metadata, and scripts
|-- pnpm-workspace.yaml      # Dependency compatibility and build permissions
|-- zotero-plugin.config.ts  # Build, serve, and test configuration
```

- Read plugin identity and preference names from `package.json`'s `config` rather
  than hardcoding them. Scaffold replaces `__addon*__` placeholders during builds.
- Edit source files in `src/` and `addon/`; `.scaffold/` contains generated output.
  Scaffold also generates `typings/i10n.d.ts` and `typings/prefs.d.ts` from the
  locale and preference sources.

## Toolchain and Commands

Use Node.js 24 and the pnpm version pinned in `package.json`. Commit
`pnpm-lock.yaml` when changing dependencies.

| Command                          | Purpose                                                         |
| -------------------------------- | --------------------------------------------------------------- |
| `pnpm install --frozen-lockfile` | Install the locked dependencies                                 |
| `pnpm start`                     | Start Zotero with the plugin and watch source changes           |
| `pnpm build`                     | Build the XPI in `.scaffold/build/` and run TypeScript checking |
| `pnpm lint:check`                | Check Prettier formatting and ESLint rules                      |
| `pnpm run test --no-watch`       | Run the Zotero integration tests once                           |

The `zotero-types` Git dependency invokes npm during preparation, so installation
also needs npm available.

## Testing

- Test each module through its public interface and assert observable behavior. Keep private helpers private; do not import, expose, or mock them for tests.
- Use test doubles only at external boundaries. Exercise internal collaborating modules with their real implementations.

- The current integration test checks that the plugin instance exists in Zotero.
  Set `ZOTERO_PLUGIN_ZOTERO_BIN_PATH` using `.env.example`. Tests use a disposable
  profile and data directory under `.scaffold/test/`, cleared before each run.
- For `pnpm start`, configure a separate development profile and data directory
  using `.env.example`; serve modifies the selected profile's `prefs.js`.
- On Linux, scaffold's serve/test cleanup defaults to `pkill -9 zotero`. Run these
  commands after closing existing Zotero sessions, or configure
  `ZOTERO_PLUGIN_KILL_COMMAND` to target only the development/test process.
- Exercise the template examples against disposable items: example handlers can
  change item titles.

## Issue tracker

Issues live in GitHub Issues; use the `gh` CLI.
