function createSeededRandom(seedInput) {
  const source = String(seedInput || "kabbak");
  let hash = 1779033703 ^ source.length;
  for (let index = 0; index < source.length; index += 1) {
    hash = Math.imul(hash ^ source.charCodeAt(index), 3432918353);
    hash = (hash << 13) | (hash >>> 19);
  }

  return function nextRandom() {
    hash = Math.imul(hash ^ (hash >>> 16), 2246822507);
    hash = Math.imul(hash ^ (hash >>> 13), 3266489909);
    const result = (hash ^= hash >>> 16) >>> 0;
    return result / 4294967296;
  };
}

module.exports = {
  createSeededRandom
};
