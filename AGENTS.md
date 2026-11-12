# Calgary

Read [STYLEGUIDE.md](STYLEGUIDE.md) before changing the game. Preserve working gameplay, Calgary geography, authored landmarks and third-party credits.

Use the existing Node.js, JavaScript, Three.js, Vite and Prettier stack. Run `npm test` and `npm run build` for relevant changes. Test actual browser rendering and frame times when changing interactive behavior or graphics. Reuse one browser tab where practical.

Keep commits limited to the game, runtime assets, required build tools, focused tests, licenses and these maintenance guides. Research, audit reports, checklists, screenshots, handoffs, downloads and generated history stay local and ignored. Review the complete staged file list before committing. Never commit credentials, dependencies or build output.

The GitHub repository `edwinzhng/slop-calgary` is public. Pushes to `main` deploy to the personal Vercel project `slop-calgary` in scope `edwinzhang`. Test on localhost before pushing and verify the production deployment afterward. Deploy only to that Vercel project. Do not rewrite shared Git history without explicit authorization.
