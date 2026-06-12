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

// src/utils/extract-json.ts
function extractJson(text) {
  const cleaned = text.replace(/```(?:json|javascript|js|ts|typescript)?([\s\S]*?)```/g, "$1").trim();
  const direct = tryParse(cleaned);
  if (direct !== null) return direct;
  const match = cleaned.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (!match) return null;
  const extracted = match[0];
  const fromBlock = tryParse(extracted);
  if (fromBlock !== null) return fromBlock;
  return tryParse(repairUnescapedQuotes(extracted));
}
function tryParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}
function repairUnescapedQuotes(str) {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    if (escaped) {
      result += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      result += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      if (!inString) {
        inString = true;
        result += char;
      } else {
        const rest = str.slice(i + 1).trimStart();
        const next = rest[0];
        if ([",", "}", "]", ":"].includes(next) || rest.length === 0) {
          inString = false;
          result += char;
        } else {
          result += '\\"';
        }
      }
      continue;
    }
    result += char;
  }
  return result;
}

export {
  siteKey,
  extractCode,
  createLock,
  extractJson,
  repairUnescapedQuotes
};
//# sourceMappingURL=chunk-7RVOYF2S.js.map