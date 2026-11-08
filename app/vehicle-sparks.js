import * as THREE from 'three/webgpu';

export function createVehicleSparks(scene) {
  const count = 48;
  const mesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.025, 0.025, 0.19),
    new THREE.MeshBasicNodeMaterial({ color: 0xffbb4d, toneMapped: false }),
    count,
  );
  mesh.name = 'Vehicle impact sparks';
  mesh.frustumCulled = false;
  mesh.count = 0;
  mesh.visible = false;
  scene.add(mesh);

  const pool = Array.from({ length: count }, () => ({ life: 0 }));
  const dummy = new THREE.Object3D();
  let cursor = 0;
  return {
    emit({ x, y, z, speed }, dx, dz) {
      if (![x, y, z, speed, dx, dz].every(Number.isFinite)) return;
      for (let i = 0; i < Math.min(14, 4 + speed); i++) {
        const spark = pool[cursor++ % count];
        const fan = (Math.random() - 0.5) * 1.7;
        const scatter = 2 + Math.random() * 6;
        spark.x = x + dx * 1.4;
        spark.y = y + 0.45;
        spark.z = z + dz * 1.4;
        spark.vx = (-dx + dz * fan) * scatter;
        spark.vz = (-dz - dx * fan) * scatter;
        spark.vy = 0.8 + Math.random() * 2.5;
        spark.life = 0.16 + Math.random() * 0.28;
      }
    },
    update(dt) {
      let live = 0;
      for (const spark of pool) {
        if (spark.life <= 0) continue;
        spark.life -= dt;
        spark.vy -= 12 * dt;
        spark.x += spark.vx * dt;
        spark.y += spark.vy * dt;
        spark.z += spark.vz * dt;
        dummy.position.set(spark.x, spark.y, spark.z);
        dummy.rotation.set(
          -Math.atan2(spark.vy, Math.hypot(spark.vx, spark.vz)),
          Math.atan2(spark.vx, spark.vz),
          0,
          'YXZ',
        );
        dummy.scale.setScalar(Math.min(1, Math.max(0.05, spark.life * 9)));
        dummy.updateMatrix();
        mesh.setMatrixAt(live++, dummy.matrix);
      }
      mesh.count = live;
      mesh.visible = live > 0;
      if (live) mesh.instanceMatrix.needsUpdate = true;
    },
  };
}
