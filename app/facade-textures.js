/** Share one image/texture among nearby crops, retaining it only while used. */
export function createFacadeTexturePool(loader, configure = () => {}) {
  const entries = new Map();
  let closed = false,
    requests = 0,
    disposedTextures = 0;
  const collect = (entry) => {
    if (entry.users.size || entry.state === 'loading') return;
    if (entries.get(entry.url) === entry) entries.delete(entry.url);
    if (entry.texture) {
      entry.texture.dispose();
      entry.texture = null;
      disposedTextures++;
    }
  };
  const notify = (entry, user) => {
    if (!user.active) return;
    if (entry.state === 'ready') user.ready(entry.texture);
    else if (entry.state === 'failed') user.error?.();
  };
  return {
    acquire(url, ready, error) {
      if (closed) throw new Error('Facade texture pool is disposed');
      let entry = entries.get(url);
      const fresh = !entry;
      if (fresh) {
        entry = { url, state: 'loading', texture: null, users: new Set() };
        entries.set(url, entry);
      }
      const user = { ready, error, active: true };
      entry.users.add(user);
      if (fresh) {
        requests++;
        const pending = loader.load(
          url,
          (texture) => {
            if (entry.state !== 'loading') return;
            entry.texture = texture;
            entry.state = 'ready';
            if (entry.users.size) configure(texture);
            for (const user of [...entry.users]) notify(entry, user);
            collect(entry);
          },
          undefined,
          () => {
            if (entry.state !== 'loading') return;
            entry.state = 'failed';
            for (const user of [...entry.users]) notify(entry, user);
            collect(entry);
          },
        );
        // Also support a loader that completes synchronously from its own cache.
        if (!entry.texture && entry.state === 'loading') entry.texture = pending;
        else if (entry.state === 'failed' && pending) {
          entry.texture = pending;
          collect(entry);
        }
      } else notify(entry, user);
      return {
        release() {
          if (!user.active) return;
          user.active = false;
          entry.users.delete(user);
          collect(entry);
        },
      };
    },
    get stats() {
      let pendingImages = 0,
        readyImages = 0,
        references = 0;
      for (const entry of entries.values()) {
        pendingImages += entry.state === 'loading';
        readyImages += entry.state === 'ready';
        references += entry.users.size;
      }
      return {
        imageEntries: entries.size,
        pendingImages,
        readyImages,
        references,
        requests,
        disposedTextures,
      };
    },
    dispose() {
      closed = true;
      for (const entry of entries.values()) {
        for (const user of entry.users) user.active = false;
        entry.users.clear();
        collect(entry);
      }
    },
  };
}
