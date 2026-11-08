import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildRoutingGraph, createRouter, findRoute, projectOnRoute } from '../app/routing.js';
import { nearestOnSegment, project } from '../app/geo.js';

const road = (id, points, extra = {}) => ({
  id,
  points,
  name: id,
  kind: 'residential',
  oneway: 'no',
  ...extra,
});

test('the transit mall stays available on foot without routing private vehicles down the tracks', () => {
  const graph = buildRoutingGraph([
    road(
      '7 Avenue',
      [
        [0, 0],
        [100, 0],
      ],
      { transitOnly: true },
    ),
    road('8 Avenue', [
      [0, 0],
      [0, 60],
      [100, 60],
      [100, 0],
    ]),
  ]);
  const walk = findRoute(graph, [0, 0], [100, 0], 'walk');
  const drive = findRoute(graph, [0, 0], [100, 0], 'drive');
  const cycle = findRoute(graph, [0, 0], [100, 0], 'cycle');
  assert.equal(walk.distance, 100);
  assert.ok(drive.distance >= 220 && cycle.distance >= 220);
  assert.ok(drive.segments.every((p) => p.roadId !== '7 Avenue'));
});

test('virtual endpoints obey forward/reverse one-ways without snapping to the wrong end', () => {
  const graph = buildRoutingGraph([
    road(
      'east-only',
      [
        [0, 0],
        [100, 0],
      ],
      { oneway: 'yes' },
    ),
    road(
      'return',
      [
        [100, 0],
        [100, 100],
        [0, 100],
        [0, 0],
      ],
      { oneway: 'yes' },
    ),
  ]);
  const forward = findRoute(graph, [30, 0], [70, 0], 'drive');
  assert.equal(forward.status, 'ok');
  assert.equal(forward.distance, 40);
  const backward = findRoute(graph, [70, 0], [30, 0], 'drive');
  assert.equal(backward.status, 'ok');
  assert.equal(backward.distance, 360);
  assert.deepEqual(backward.points, [
    [70, 0],
    [100, 0],
    [100, 100],
    [0, 100],
    [0, 0],
    [30, 0],
  ]);
  assert.equal(findRoute(graph, [70, 0], [30, 0], 'walk').distance, 40);
  assert.equal(findRoute(graph, [70, 0], [30, 0], 'cycle').distance, 360);
  const reversed = buildRoutingGraph([
    road(
      'west-only',
      [
        [0, 0],
        [100, 0],
      ],
      { oneway: '-1' },
    ),
  ]);
  assert.equal(findRoute(reversed, [70, 0], [30, 0], 'drive').distance, 40);
  assert.equal(findRoute(reversed, [30, 0], [70, 0], 'drive').status, 'unreachable');
});

test('footbridges connect people, not cars, while a grade-separated crossing never creates a junction', () => {
  const graph = buildRoutingGraph([
    road(
      'bridge',
      [
        [0, 0],
        [100, 0],
      ],
      { kind: 'cycleway', bridge: true },
    ),
    road(
      'overpass',
      [
        [50, -100],
        [50, 100],
      ],
      { bridge: true, layer: 1 },
    ),
  ]);
  for (const mode of ['walk', 'cycle']) {
    const route = findRoute(graph, [0, 0], [100, 0], mode);
    assert.equal(route.status, 'ok');
    assert.ok(route.segments.every((segment) => segment.bridge));
  }
  assert.equal(findRoute(graph, [0, 0], [100, 0], 'drive', { maxSnap: 10 }).status, 'off-network');
  assert.equal(findRoute(graph, [0, 0], [50, 100], 'walk', { maxSnap: 1 }).status, 'unreachable');
});

test('stairs/expressways/tunnels/access restrictions remain mode-specific and unroutable gaps remain gaps', () => {
  for (const extra of [{ tunnel: true }, { access: 'private' }, { kind: 'corridor' }]) {
    const graph = buildRoutingGraph([
      road(
        'closed',
        [
          [0, 0],
          [100, 0],
        ],
        extra,
      ),
    ]);
    assert.equal(findRoute(graph, [0, 0], [100, 0], 'walk').status, 'off-network');
  }
  const stairs = buildRoutingGraph([
    road(
      'steps',
      [
        [0, 0],
        [100, 0],
      ],
      { kind: 'steps' },
    ),
  ]);
  assert.equal(findRoute(stairs, [0, 0], [100, 0], 'walk').status, 'ok');
  assert.equal(findRoute(stairs, [0, 0], [100, 0], 'cycle').status, 'off-network');
  const motorway = buildRoutingGraph([
    road(
      'highway',
      [
        [0, 0],
        [100, 0],
      ],
      { kind: 'motorway' },
    ),
  ]);
  assert.equal(findRoute(motorway, [0, 0], [100, 0], 'drive').status, 'ok');
  assert.equal(findRoute(motorway, [0, 0], [100, 0], 'walk').status, 'off-network');
  const gap = buildRoutingGraph([
    road('a', [
      [0, 0],
      [100, 0],
    ]),
    road('b', [
      [200, 0],
      [300, 0],
    ]),
  ]);
  assert.equal(findRoute(gap, [0, 0], [300, 0], 'drive', { maxSnap: 1 }).status, 'unreachable');
  assert.equal(findRoute(gap, [0, 0], [300, 0], 'fly').distance, 300);
  assert.equal(findRoute(gap, [NaN, 0], [300, 0]).status, 'invalid');
});

test('route progress projects onto segments and measures remaining physical distance', () => {
  const graph = buildRoutingGraph([
    road('bend', [
      [0, 0],
      [100, 0],
      [100, 100],
    ]),
  ]);
  const route = findRoute(graph, [0, 0], [100, 100]);
  const a = projectOnRoute(route, 70, 4);
  assert.equal(a.along, 70);
  assert.equal(a.remaining, 130);
  assert.equal(a.distance, 4);
  const b = projectOnRoute(route, 105, 80);
  assert.equal(b.remaining, 20);
  assert.deepEqual(b.point, [100, 80]);
  assert.equal(findRoute(graph, [0, 0], [100, 100], 'walk', { maxVisited: 0 }).status, 'limit');
});

test('real Calgary routes use continuous mapped vertices, bridges and legal directed road segments', async () => {
  const data = JSON.parse(fs.readFileSync(new URL('../data/calgary.json', import.meta.url))),
    roads = new Map(data.roads.map((r) => [r.id, r])),
    router = createRouter(data.roads);
  let yields = 0;
  await router.prepare(async () => yields++);
  assert.ok(yields > 0, 'graph preparation yields to the rendering/UI loop');
  assert.ok(router.stats.nodes > 50000);
  const from = project(-114.0713, 51.0318),
    to = project(-114.0857, 51.0553);
  for (const mode of ['drive', 'walk', 'cycle']) {
    const route = router.route(from, to, mode);
    assert.equal(route.status, 'ok', `${mode}: ${route.status}`);
    assert.ok(route.distance > 2500 && route.distance < 5500);
    assert.ok(
      route.segments.some((s) => s.bridge),
      'Bow River crossing must be a mapped bridge',
    );
    assert.ok(route.visited < 20000, 'bounded A* search across the core');
    for (let i = 0; i < route.segments.length; i++) {
      const segment = route.segments[i],
        source = roads.get(segment.roadId);
      assert.ok(source, 'every route segment belongs to an actual mapped road/path');
      if (i)
        assert.ok(
          Math.hypot(segment.a[0] - route.segments[i - 1].b[0], segment.a[1] - route.segments[i - 1].b[1]) <
            0.15,
        );
      let sourcePart;
      for (let n = 1; n < source.points.length; n++) {
        const a = nearestOnSegment(...segment.a, source.points[n - 1], source.points[n]),
          b = nearestOnSegment(...segment.b, source.points[n - 1], source.points[n]);
        if (a.distance < 0.15 && b.distance < 0.15) {
          sourcePart = { a, b };
          break;
        }
      }
      assert.ok(sourcePart, 'no synthetic river-crossing or block-shortcut edges');
      if (mode !== 'walk') {
        if (source.oneway === '-1') assert.ok(sourcePart.b.t <= sourcePart.a.t + 0.0001);
        else if (source.oneway && source.oneway !== 'no')
          assert.ok(sourcePart.b.t >= sourcePart.a.t - 0.0001);
      }
      if (mode === 'drive')
        assert.ok(!['footway', 'cycleway', 'path', 'steps', 'corridor', 'service'].includes(source.kind));
    }
  }
});
