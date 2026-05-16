// src/utils/site-key.ts
function siteKey(url) {
  try {
    const u = new URL(url);
    return u.hostname.toLowerCase() + u.pathname.replace(/\/$/, "");
  } catch {
    return url;
  }
}

// src/utils/code-fence.ts
function extractCode(text) {
  const match = text.match(/```(?:javascript|js)?\s*\n([\s\S]*?)```/);
  return match ? match[1].trim() : text;
}

// src/utils/lock.ts
function createLock() {
  let queue = Promise.resolve();
  return {
    withLock(fn) {
      const next = queue.then(fn, fn);
      queue = next.catch(() => {
      });
      return next;
    }
  };
}

export {
  siteKey,
  extractCode,
  createLock
};
//# sourceMappingURL=chunk-467GZRWL.js.map