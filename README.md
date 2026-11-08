# Calgary

A playable central Calgary inspired by [Mr.doob’s Slop New York](https://github.com/mrdoob/slop-newyork). Walk, run, bike, drive or fly through downtown, East Village, Kensington/Sunnyside and Mission.

Requires Node.js 22.12 or newer. No API key or backend is needed.

```sh
npm ci
npm run dev
```

```sh
npm test
npm run build
npm run preview
```

Use `npm run crossings:bake` after changing crossing geometry or its inputs. The build rejects a stale crossing cache.

The static release contains the game and its licensed assets. Content-hashed assets use long-lived browser caching; facade finishes and lettering render from local geometry and procedural materials. Development research and audit tools are local and excluded from commits and deployment.

See [STYLEGUIDE.md](STYLEGUIDE.md) for contribution rules and [THIRD_PARTY.md](THIRD_PARTY.md) for licenses and data attribution.
