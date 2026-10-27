// Startup asset preflight: HEAD-checks every file in assets.manifest.json (presence + exact byte size) against this server.
// Hashes are verified offline by tools/check_assets.mjs (hashing 2 GB in the page would stall startup). Nothing is downloaded.
// A deployed release with a hosting map (playground/hosting.json) takes its large model files from revision-pinned Hugging Face repositories. Those are
// not contacted at startup (no third-party request before a model is used; their sizes and sha256 were checked against the Hub when the release was
// built). Only when this site itself is unreachable are they checked, against the copies the service worker saved on this device (it answers such
// HEAD requests from Cache Storage without using the network).
export async function checkAssets(manifestUrl = 'assets.manifest.json') {
  const [res, hosting] = await Promise.all([fetch(manifestUrl, {cache: 'no-store'}),
    fetch('hosting.json', {cache: 'no-cache'}).then((r) => (r.ok ? r.json() : null), () => null)]);
  if (!res.ok) throw new Error(`asset manifest not found (HTTP ${res.status})`);
  const man = await res.json(), remote = hosting?.files || {};
  const head = async (url, f, missing) => {
    try {
      const r = await fetch(url, {method: 'HEAD', cache: 'no-store'});
      const n = r.headers.get('content-length'), encoded = r.headers.get('content-encoding');   // a compressed (or chunked) reply has no comparable length
      if (!r.ok) missing.push({path: f.path, why: r.status === 504 && remote[f.path] ? 'unreachable' : `HTTP ${r.status}`});
      else if (n != null && !encoded && +n !== f.bytes) missing.push({path: f.path, why: `size ${n} ≠ expected ${f.bytes}`});
    } catch { missing.push({path: f.path, why: 'unreachable'}); }
  };
  const groups = await Promise.all(man.groups.map(async (g) => {
    const missing = [];
    await Promise.all(g.files.filter((f) => !remote[f.path]).map((f) => head('../' + f.path, f, missing)));
    return {model: g.model, tier: g.tier, label: g.label, source: g.source, files: g.files.length, bytes: g.files.reduce((a, f) => a + f.bytes, 0), missing,
      hosted: g.files.filter((f) => remote[f.path]).length};
  }));
  const siteDown = groups.some((g) => g.missing.some((m) => m.why === 'unreachable')) || navigator.onLine === false;
  if (siteDown && navigator.serviceWorker?.controller)
    await Promise.all(groups.map((g) => Promise.all(man.groups.find((x) => x.model === g.model).files.filter((f) => remote[f.path]).map((f) => head(remote[f.path], f, g.missing)))));
  for (const g of groups) g.ok = g.missing.length === 0;
  return {groups, byModel: Object.fromEntries(groups.map((g) => [g.model, g])), hosting};
}
