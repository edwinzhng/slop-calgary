# Calgary style guide

## Product and interface

- Keep exploring the city as the primary activity. Preserve walk, run, bike, drive and fly controls, collision handling, camera zoom and the expandable map.
- Use the existing graphite glass HUD, restrained yellow selection, green street signs and shared tokens in `app/style.css`. Compose existing controls in `app/ui.js` and `index.html` before adding a new visual pattern.
- Keep labels short, in sentence case, and tied to visible actions. Remove repeated titles, subtitles, promotional claims and renderer terminology from normal play.
- Use consistent SVG icons with accessible names. Check focus, hover, selected and disabled states. Preserve keyboard and touch controls, safe areas and reduced-motion support.
- Keep each modal responsible for one task. Pause movement while a modal is open. Check desktop and narrow touch layouts in the browser.

## Code and comments

- Use clear JavaScript module names and one source of truth for each setting, coordinate system, actor state and UI action. Keep DOM work in UI modules and geometry or physics in their owning modules.
- Extend an existing helper when it owns the behavior. Add an abstraction only when it removes real duplication or enforces a required constraint.
- Use metres, seconds and radians consistently. Name units where the value could be mistaken. Preserve deterministic geography and explicit source identities.
- Write comments for rendering, physics, browser, licensing or data constraints that the code cannot express. Remove comments that narrate edits, repeat statements or record conversation history.
- Prefer short, direct sentences and active voice in copy and comments. Report errors with a useful recovery action; keep raw diagnostics out of normal player flows.
- Keep changes focused. Use Prettier on changed files. Add tests for meaningful behavior and failure paths; do not add snapshots or tests that restate the implementation.

## Geometry and assets

- Compare against dated, licensed references. Fix silhouettes, proportions, placement and broad materials before small decoration. Distinguish measured geometry from inferred detail.
- Scope material corrections to observed faces and disable them if their source mesh changes. Match the complete ordered owner list for compound shells. Map curved glazing continuously across adjacent facets.
- Keep business destinations at their mapped frontage projections. Resolve crowded signs separately from search destinations; do not spread tenants across a building edge by rank or infer permanent storefronts for marketplace POIs. Accepted authored frontages suppress generic shop bodies while retaining their destinations.
- Keep observed lane fallbacks separate from mapped lane counts. Require exact source geometry and road properties, expire the fallback when those change, and give explicit lane or width measurements priority.
- Match guideway construction details to exact rail sources. Keep deck, walking support and track profiles consistent; retain existing rail and platform heights when correcting finishes. Mark unmeasured detail dimensions as inferred.
- Preserve building courtyards, source roof forms, bridge clearance, sidewalk connections and shared support heights. A visual change must agree with collisions and navigation.
- Share source-aware bridge cross sections between decks, rails, blockers and connection hardware. Query rendered triangle planes for support, preserve source corners, and open inferred rails only at mapped connections with matching deck levels.
- Prepare bounded edge indexes for long static surface polygons when repeated support queries are expensive. Keep exact source coordinates, crossing comparisons, holes and source identities; retain direct queries for short or mutable geometry and rebuild indexes after coordinate edits.
- Build authored bank connections before generic approaches. Use the same surface factories for the game and offline crossing bake, and preserve exact source-node ownership at their handoffs.
- At pedestrian deck ends, open inferred rails only through a mapped approach with an exact shared source point and matching joint height. Check the entire clipped interval against the existing walking step limit; retain guards at unconnected or vertically separated surfaces.
- Keep character scale, rig bindings and animation blending coherent with movement. Check feet, wheel contact, turns and camera clearance during actual play.
- Ship only assets used by the game. Keep binary geometry and the player GLB; avoid duplicate exports, unused textures and source photographs outside the licensed facade collection.
- Preserve creator, source and license attribution for every third-party asset. Keep original license files intact. Changes to photographic crops or adaptations retain the image license.
- Use instancing, shared materials, bounded nearby detail and appropriate distance culling. Verify triangle counts, draw calls, frame times and load behavior before claiming a performance improvement.
- Derive distant terrain silhouettes from elevation data in Calgary's true compass directions. Keep the backdrop outside physics, shadows and reflection probes. Fade distant detail with weather, and fade unsupported camera heights without constraining movement; do not enlarge mountain heights for effect.
- Preserve the scene's light set across travel modes. Hide unused vehicle bodies and switch their light intensity off; keep their lights in the scene to avoid rebuilding city shaders.
- Use 0.75 render pixels per CSS pixel in Performance, one in Balanced, and cap high-detail supersampling at 1.25. Keep the HUD at native display resolution. Keep WebGPU instance transforms in versioned storage buffers and preserve ordinary instance attributes on WebGL.
- Split citywide road, rail and Plus 15 geometry into spatial batches so camera culling can skip off-screen sections. Warm visible shader variants from one matrix snapshot, using the same camera bounds as the renderer.
- Prepare fresh bounds for final static meshes with exact packed-coordinate arithmetic. Preserve authored bounds and shared unsafe owners; keep instanced, batched, skinned, morphed and custom-displaced geometry on their existing path. Check actual view and shadow draws before claiming a load improvement.
- Render the city MRT pass before the post-processing quad so warmup and live draws share the same render context. Preserve MSAA, reflections, bloom and the final color transform; restore renderer state on failures and check resizing and transparent surfaces.
- Defer two-pass transparent materials when async compilation cannot retain each face side. Suppress their materials during recursive warmup, preserve child lights and restore visibility after every job settles. Use one double-sided pass for flat precipitation cards.
- Cull tree cells independently for view and shadow cameras without rewriting GPU instance buffers on camera turns. Keep complete instance records together, include wind and measured trunk displacement in bounds, restore interrupted pass selections and retain direct draws when indirect first-instance support is unavailable.
- Keep opaque shadow alpha independent of facade shading. Preserve the original main color graph, vertex positions, depth, face side and shadow bias.
- Keep complete paint primitives and every shader input when partitioning markings. Expand each piece's culling bounds by the material's maximum vertex displacement, including pixel-width filtering.
- Share render state across static pieces with Three.js batching when measurements support it. Preserve source attributes and independent camera/shadow culling; check WebGL fallback and first-use shader cost.
- Use immutable indirect triangle ranges for static cells on WebGPU when measurements support them. Preserve source bounds and draw order, select view and shadow ranges independently, recover interrupted passes and count submitted commands in diagnostics. Retain the WebGL path.
- Share regional building buffers while retaining each tile's view and shadow distance limits through the actual shadow draw callback. Keep unsupported renderers on ordinary building tiles. Measure CPU submission and initial GPU uploads together when widening batches.
- Decode shared city-mesh vertices once per record using double precision before packing positions and face normals. Compare every drawn attribute when adding a packed facade fast path; retain observed finishes and custom-attribute behavior.
- Build only the tree detail levels used by the game. Cache immutable instance records and expanded bark bounds lazily per record and detail level. Preserve measured trunk shaping, wind bounds and source order; hide empty populations without disabling callbacks for populated pools culled from one view.
- Retain indices when merging geometry with the same index layout. Expand mixed layouts only where required; compare the complete drawn attribute stream, culling and GPU buffer sizes before claiming a gain.
- Build linear surface contours without allocating a curve for every edge. Preserve Three's endpoint sampling, duplicate removal, hole winding, triangulation and separate Float32 transforms; retain the original factory for unsupported input.
- Reuse parking primitive buffers while preserving Three's separate Float32 rotation and translation, per-box terrain subdivision and complete drawn attributes. Keep nearest-lot order, blocker exclusions and the global car and wheel-stop cap unchanged.
- Bound cached infrastructure primitives by bytes and entries. Invalidate changed source definitions, preserve selected stream and signal descriptor order, and transfer inactive tile ownership without retaining extra meshes. Dispose evicted geometry once and check cold travel as well as revisits.
- Keep full car models nearby and use matching silhouettes at distance, with hysteresis at detail transitions. Retain each vehicle's transform, paint and light state across detail levels; keep simulation and collision bodies unchanged.
- Apply reference-based finishes to matching source walls. Use physical wall coordinates for material patterns and attach lettering separately. Keep reference photographs out of the runtime bundle.

## Loading and releases

- Keep the game static and self-contained. Movement must not call external map APIs or download a new city copy.
- Publish versioned assets under content-hashed names and cache them immutably. Keep HTML revalidatable so a new release selects the correct assets.
- Keep first-visit downloads on the shortest dependency path. Preload only required assets with matching fetch credentials and low priority; keep optional imagery on demand. Verify that preloads reuse requests in the browser.
- Preserve measured geometry exactly when changing transport formats. Check a full-data lossless round trip during the build, reject malformed payloads and compare compressed transfer size plus decode time.
- Share repeated record fields where compressed-size and decode checks support it; preserve source field order, missing values and identifiers. Decode before validation or geometry construction. Overlap graphics-device initialization with required downloads.
- Group matching record fields into columns when that reduces compressed transfer. Preserve interleaved schema order and reject incomplete columns before constructing game records. Check full-data decode time as well as bytes.
- Group matching mesh coordinate streams across records when compression improves. Version the transport layout and prove every source byte survives, including mixed index widths. Keep the raw download size from increasing.
- Start building enhancement downloads alongside the main map. Await both before validating source ownership; a failed enhancement must retain its complete baseline building.
- Start avatar preparation alongside city downloads and pass the prepared player into the actors. Keep one rig, one asset request and one readiness promise through startup.
- Check generated geometry during the build. Do not make every player's browser download authoring source to validate a cache. Bake expensive fixed curb selection with crossing paint, retain exact double-precision coordinates and live source ownership, and fall back to the runtime builder when validation fails. Rebuild with `npm run crossings:bake` when inputs change.
- Test network behavior on localhost. Use small production checks after a release; avoid repeated full production reloads and duplicate deployments.
- Keep commits and deployment inputs limited to the game and its necessary maintenance files. Keep research and verification evidence local. Do not check in generated output, audit ledgers, historical notes, private configuration or credentials.
- Inspect the staged diff, run focused checks and build from the intended release files. A passing local build does not prove mobile frame rate or exact real-world accuracy; state verification limits plainly.
