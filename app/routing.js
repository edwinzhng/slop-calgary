import { DRIVABLE, SpatialIndex, bounds, nearestOnSegment } from './geo.js';

const DRIVE = 1,
  WALK = 2,
  CYCLE = 4;
const fastRoads = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link']);
const paths = new Set(['footway', 'path', 'cycleway', 'pedestrian', 'track', 'steps']);
const modeBit = (mode) => (mode === 'drive' ? DRIVE : mode === 'cycle' ? CYCLE : WALK);
// Same 10 cm node identity as the real-road graph used by city traffic. Only
// shared OSM vertices connect: a visual crossing does not create a junction.
const nodeKey = (p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`;
const distance = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

function permissions(road) {
  if (road.transitOnly && !road.tunnel) return [WALK, WALK];
  if (road.tunnel || ['private', 'no'].includes(road.access)) return [0, 0];
  const street = DRIVABLE.has(road.kind),
    safeStreet = street && !fastRoads.has(road.kind),
    walk = safeStreet || paths.has(road.kind),
    cycle = safeStreet || (paths.has(road.kind) && road.kind !== 'steps');
  let forward = walk ? WALK : 0,
    reverse = forward;
  const vehicles = (street && road.kind !== 'service' ? DRIVE : 0) | (cycle ? CYCLE : 0);
  const oneWay = String(road.oneway || 'no').toLowerCase();
  if (oneWay !== '-1') forward |= vehicles;
  if (['no', 'false', '0', '-1'].includes(oneWay)) reverse |= vehicles;
  return [forward, reverse];
}

function weight(road, mode) {
  if (mode === 'drive') return road.kind === 'residential' ? 1.06 : 1;
  if (mode === 'cycle') {
    if (road.kind === 'cycleway') return 1;
    if (['path', 'track'].includes(road.kind)) return 1.08;
    if (['footway', 'pedestrian'].includes(road.kind)) return 1.35;
    return ['primary', 'secondary'].includes(road.kind) ? 1.8 : 1.22;
  }
  return paths.has(road.kind) ? (road.kind === 'steps' ? 1.3 : 1) : 1.12;
}

// One shared graph serves all modes, built lazily on the first destination.
// Indoor corridors, tunnels and motorways for people are deliberately omitted;
// there is no straight-line fallback pretending that a river has a crossing.
function emptyGraph() {
  return { nodes: new Map(), segments: [], index: new SpatialIndex(90), edgeCount: 0 };
}

function appendRoad(graph, road) {
  const { nodes, segments, index } = graph;
  const node = (key, p) => {
    if (!nodes.has(key)) nodes.set(key, { p, edges: [] });
    return nodes.get(key);
  };
  const [forward, reverse] = permissions(road);
  if (!(forward | reverse)) return;
  for (let i = 1; i < road.points.length; i++) {
    const a = road.points[i - 1],
      b = road.points[i],
      length = distance(a, b),
      aKey = nodeKey(a),
      bKey = nodeKey(b);
    if (aKey === bKey || length < 0.2) continue;
    const segment = { a, b, aKey, bKey, road, length, forward, reverse };
    segments.push(segment);
    index.insert(segment, bounds([a, b]));
    const na = node(aKey, a),
      nb = node(bKey, b);
    if (forward) {
      na.edges.push({ to: bKey, segment, mask: forward, forward: true });
      graph.edgeCount++;
    }
    if (reverse) {
      nb.edges.push({ to: aKey, segment, mask: reverse, forward: false });
      graph.edgeCount++;
    }
  }
}

export function buildRoutingGraph(roads) {
  const graph = emptyGraph();
  for (const road of roads) appendRoad(graph, road);
  return graph;
}

class MinHeap {
  items = [];
  push(item) {
    let i = this.items.length;
    this.items.push(item);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.items[p].score <= item.score) break;
      this.items[i] = this.items[p];
      i = p;
    }
    this.items[i] = item;
  }
  pop() {
    const first = this.items[0],
      last = this.items.pop();
    if (this.items.length) {
      let i = 0;
      while (i * 2 + 1 < this.items.length) {
        let child = i * 2 + 1;
        if (child + 1 < this.items.length && this.items[child + 1].score < this.items[child].score) child++;
        if (last.score <= this.items[child].score) break;
        this.items[i] = this.items[child];
        i = child;
      }
      this.items[i] = last;
    }
    return first;
  }
}

function anchors(graph, point, bit, maxSnap) {
  const found = [];
  for (const segment of graph.index.near(...point, maxSnap)) {
    if (!((segment.forward | segment.reverse) & bit)) continue;
    const p = nearestOnSegment(...point, segment.a, segment.b);
    if (p.distance <= maxSnap) found.push({ ...p, p: [p.x, p.z], segment });
  }
  found.sort((a, b) => a.distance - b.distance);
  // On an actual street do not jump across the block to bypass a one-way. A
  // little choice is useful for a park/building entrance off the network.
  const limit = found[0]?.distance + (found[0]?.distance <= 12 ? 3 : 25),
    result = [],
    seen = new Set();
  for (const anchor of found) {
    if (anchor.distance > limit || result.length >= 6) break;
    const key = `${anchor.segment.road.id}:${nodeKey(anchor.p)}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(anchor);
    }
  }
  return result;
}

function piece(a, b, road) {
  return {
    a,
    b,
    roadId: road.id,
    kind: road.kind,
    name: road.name || '',
    bridge: !!road.bridge,
    oneway: road.oneway || 'no',
    length: distance(a, b),
  };
}

function result(parts, start, end, mode, visited) {
  const segments = parts.filter((part) => part.length > 0.02),
    points = segments.length ? [segments[0].a, ...segments.map((part) => part.b)] : [start.p],
    cumulative = [0];
  for (let i = 1; i < points.length; i++)
    cumulative.push(cumulative.at(-1) + distance(points[i - 1], points[i]));
  return {
    status: 'ok',
    mode,
    points,
    segments,
    cumulative,
    distance: cumulative.at(-1),
    accessDistance: start.distance + end.distance,
    start: start.p,
    end: end.p,
    destination: end.destination,
    visited,
  };
}

export function findRoute(
  graph,
  from,
  destination,
  mode = 'walk',
  { maxVisited = 65000, maxSnap = mode === 'drive' ? 130 : 90 } = {},
) {
  if (![...from, ...destination].every(Number.isFinite)) return { status: 'invalid' };
  if (mode === 'fly') {
    const length = distance(from, destination);
    return {
      status: 'ok',
      mode,
      points: [from, destination],
      segments: [],
      cumulative: [0, length],
      distance: length,
      accessDistance: 0,
      start: from,
      end: destination,
      destination,
      visited: 0,
    };
  }
  const bit = modeBit(mode),
    starts = anchors(graph, from, bit, maxSnap),
    ends = anchors(graph, destination, bit, maxSnap);
  if (!starts.length || !ends.length) return { status: 'off-network', mode };
  const queue = new MinHeap(),
    scores = new Map(),
    previous = new Map(),
    terminal = new Map();
  let best = null,
    bestCost = Infinity,
    visited = 0;
  const heuristic = (key) => distance(graph.nodes.get(key).p, destination);
  for (const end of ends) {
    end.destination = destination;
    const s = end.segment,
      add = (key, length) => {
        if (!terminal.has(key)) terminal.set(key, []);
        terminal.get(key).push({ end, cost: length * weight(s.road, mode) + end.distance * 4 });
      };
    if (s.forward & bit || end.t < 0.00001) add(s.aKey, s.length * end.t);
    if (s.reverse & bit || end.t > 0.99999) add(s.bKey, s.length * (1 - end.t));
  }
  for (const start of starts) {
    const s = start.segment,
      add = (key, length) => {
        const cost = length * weight(s.road, mode) + start.distance * 4;
        if (cost >= (scores.get(key) ?? Infinity)) return;
        scores.set(key, cost);
        previous.set(key, { start });
        queue.push({ key, cost, score: cost + heuristic(key) });
      };
    if (s.forward & bit || start.t > 0.99999) add(s.bKey, s.length * (1 - start.t));
    if (s.reverse & bit || start.t < 0.00001) add(s.aKey, s.length * start.t);
    for (const end of ends) {
      if (s !== end.segment) continue;
      const delta = end.t - start.t;
      if (!(delta >= 0 ? s.forward & bit : s.reverse & bit)) continue;
      const cost = Math.abs(delta) * s.length * weight(s.road, mode) + (start.distance + end.distance) * 4;
      if (cost < bestCost) {
        bestCost = cost;
        best = { start, end, direct: true };
      }
    }
  }
  while (queue.items.length) {
    const current = queue.pop();
    if (current.score >= bestCost) break;
    if (current.cost !== scores.get(current.key)) continue;
    if (++visited > maxVisited) return { status: 'limit', mode, visited };
    for (const target of terminal.get(current.key) || []) {
      const cost = current.cost + target.cost;
      if (cost < bestCost) {
        bestCost = cost;
        best = { key: current.key, end: target.end };
      }
    }
    const n = graph.nodes.get(current.key);
    for (const edge of n.edges) {
      if (!(edge.mask & bit)) continue;
      const cost = current.cost + edge.segment.length * weight(edge.segment.road, mode);
      if (cost >= (scores.get(edge.to) ?? Infinity)) continue;
      scores.set(edge.to, cost);
      previous.set(edge.to, { from: current.key, edge });
      queue.push({ key: edge.to, cost, score: cost + heuristic(edge.to) });
    }
  }
  if (!best) return { status: 'unreachable', mode, visited };
  if (best.direct)
    return result(
      [piece(best.start.p, best.end.p, best.start.segment.road)],
      best.start,
      best.end,
      mode,
      visited,
    );
  const parts = [],
    end = best.end;
  let key = best.key,
    prev = previous.get(key);
  parts.push(piece(graph.nodes.get(key).p, end.p, end.segment.road));
  while (prev.from !== undefined) {
    parts.push(piece(graph.nodes.get(prev.from).p, graph.nodes.get(key).p, prev.edge.segment.road));
    key = prev.from;
    prev = previous.get(key);
  }
  parts.push(piece(prev.start.p, graph.nodes.get(key).p, prev.start.segment.road));
  parts.reverse();
  return result(parts, prev.start, end, mode, visited);
}

export function projectOnRoute(route, x, z) {
  let best = { distance: Infinity, along: 0, remaining: route.distance, index: 0, point: route.points[0] };
  for (let i = 1; i < route.points.length; i++) {
    const p = nearestOnSegment(x, z, route.points[i - 1], route.points[i]);
    if (p.distance >= best.distance) continue;
    const along = route.cumulative[i - 1] + p.t * (route.cumulative[i] - route.cumulative[i - 1]);
    best = {
      distance: p.distance,
      along,
      remaining: route.distance - along,
      index: i - 1,
      point: [p.x, p.z],
    };
  }
  if (route.points.length === 1) best.distance = distance([x, z], route.points[0]);
  return best;
}

export function createRouter(roads) {
  let graph, preparing;
  return {
    prepare(yieldControl = () => new Promise((resolve) => setTimeout(resolve, 0))) {
      if (graph) return Promise.resolve();
      if (preparing) return preparing;
      preparing = (async () => {
        const pending = emptyGraph();
        let checkpoint = performance.now();
        for (const road of roads) {
          appendRoad(pending, road);
          if (performance.now() - checkpoint > 6) {
            await yieldControl();
            checkpoint = performance.now();
          }
        }
        graph = pending;
      })();
      return preparing;
    },
    route(from, to, mode = 'walk', options) {
      if (mode !== 'fly') graph ||= buildRoutingGraph(roads);
      return findRoute(graph, from, to, mode, options);
    },
    get stats() {
      return {
        nodes: graph?.nodes.size || 0,
        segments: graph?.segments.length || 0,
        edges: graph?.edgeCount || 0,
      };
    },
  };
}
