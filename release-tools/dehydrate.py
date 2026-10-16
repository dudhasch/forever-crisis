"""Developer tool: turn the explorer's generated JSON into text-free templates (extractor/data/templates.json.gz).

Every string that is written content (see textpool.is_text) is replaced by a reference into the game's own
data (MasterData strings, Lua TextAssets). Strings that cannot be referenced stay literal and are listed in
release-tools/out/literal-report.txt for review: they must be the explorer's own wording, not game text.

    .venv\\Scripts\\python.exe release-tools\\dehydrate.py

Also writes extractor/data/text-bundles.json (bundles whose TextAssets are referenced).
"""
from __future__ import annotations

import collections
import gzip
import json
import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'extractor'))
sys.path.insert(0, str(ROOT / 'release-tools'))
from ffcx import textpool as tp  # noqa: E402
from paths import get  # noqa: E402

# the maintainer's local extraction, the explorer's generated JSON, a current Steam install and the older game
# folder kept with the extraction (release-tools/paths.py)
ARCHIVE = get('FFC_ARCHIVE')
GEN = get('FFC_EXPLORER') / 'generated'
GAME_MD = get('FFC_GAME') / 'FF7EC_Data' / 'StreamingAssets' / 'MasterData'
SNAPSHOT_MD = get('FFC_CLIENT') / 'FF7EC_Data' / 'StreamingAssets' / 'MasterData'
BUNDLES = ARCHIVE / '02-DecodedBundles'
TEXT_BUNDLE_DIRS = ['data/dungeoncontentluascript', 'data/dungeon']
# Single bundles outside those folders that still carry strings the player's MasterData no longer has
# (found by scanning every data/, outgame/, story/, scenes/ ... bundle of a current install for the missing hashes).
EXTRA_TEXT_BUNDLES = ['data/dungeoncontent/0514/dat_asset_dungeon_map_0514_content_002.a', 'scenes/cutscene_ch949_boss_enter_03.s']
DATA = ROOT / 'extractor' / 'data'
REPORT = ROOT / 'release-tools' / 'out'
K, STRIDE = 24, 8
SEPARATORS = re.compile(r'( · | › |; |\n|: | / | \| )')


def main():
    t0 = time.time()
    recipe = json.loads((DATA / 'recipe.json').read_text(encoding='utf-8'))
    pool: dict[str, str] = {}
    origin: dict[str, str] = {}

    def add(s, src):
        k = tp.h(s)
        old = pool.get(k)
        if old is not None and old != s:
            raise SystemExit(f'hash collision {k}')
        if old is None:
            pool[k] = s
            origin[k] = src

    player_md = set()
    for s in tp.masterdata_strings(GAME_MD):
        add(s, 'md')
        player_md.add(tp.h(s))
    for s in tp.masterdata_strings(SNAPSHOT_MD):
        add(s, 'md-snapshot')
    text_bundles = sorted({p.relative_to(BUNDLES).as_posix() for d in TEXT_BUNDLE_DIRS for p in (BUNDLES / d).rglob('*') if p.is_file()}
                          | {x for x in EXTRA_TEXT_BUNDLES if (BUNDLES / x).is_file()})
    bundle_of: dict[str, str] = {}
    for rel in text_bundles:
        for s in tp.textasset_strings([BUNDLES / rel]):
            for x in (s, *tp.lua_literals(s)):
                add(x, 'lua')
                bundle_of.setdefault(tp.h(x), rel)
    print(f'pool: {len(pool)} strings ({len(player_md)} from this install\'s MasterData), {len(text_bundles)} text bundles, {time.time() - t0:.0f}s', flush=True)

    # k-gram index over long pool texts for substring references
    windows: dict[int, tuple[str, int]] = {}
    for k_, s in pool.items():
        if len(s) >= 32:
            for i in range(0, len(s) - K + 1, STRIDE):
                windows.setdefault(hash(s[i:i + K]), (k_, i))
    print(f'index: {len(windows)} windows, {time.time() - t0:.0f}s', flush=True)

    used: set[str] = set()
    literal = collections.Counter()
    literal_samples: dict[str, list] = collections.defaultdict(list)
    stats = collections.Counter()

    def composite(s: str):
        """Segments of pool slices and literal glue, or None."""
        segs, last, i, n = [], 0, 0, len(s)
        while i <= n - K:
            hit = windows.get(hash(s[i:i + K]))
            if hit:
                k_, pos = hit
                src = pool[k_]
                if src[pos:pos + K] == s[i:i + K]:
                    a, b = i, pos
                    while a > last and b > 0 and s[a - 1] == src[b - 1]:
                        a -= 1
                        b -= 1
                    e, f = i + K, pos + K
                    while e < n and f < len(src) and s[e] == src[f]:
                        e += 1
                        f += 1
                    if a > last:
                        segs.append(s[last:a])
                    segs.append([k_, b, e - a])
                    last = i = e
                    continue
            i += 1
        if not any(isinstance(x, list) for x in segs):
            return None
        if last < n:
            segs.append(s[last:])
        return segs

    def split_exact(s: str):
        parts = SEPARATORS.split(s)
        segs, hit = [], False
        for p in parts:
            k_ = tp.h(p)
            if p and tp.is_text(p) or (len(p) >= 3 and k_ in pool and not SEPARATORS.fullmatch(p)):
                if k_ in pool:
                    segs.append([k_, 0, len(p)])
                    hit = True
                    continue
            if p:
                segs.append(p)
        return segs if hit else None

    short = {v: k for k, v in pool.items() if 4 <= len(v) <= 80 and any(c.isalpha() for c in v)}

    def short_match(g: str):
        """Whole-word occurrences of short game strings (names, labels) inside literal glue."""
        out, i, last, n = [], 0, 0, len(g)
        while i < n:
            if i == 0 or not g[i - 1].isalnum():
                for j in range(min(n, i + 80), i + 3, -1):
                    if (j == n or not g[j].isalnum()) and g[i:j] in short:
                        if i > last:
                            out.append(g[last:i])
                        out.append([short[g[i:j]], 0, j - i])
                        last = i = j
                        break
                else:
                    i += 1
                continue
            i += 1
        if last < n:
            out.append(g[last:])
        return out

    def literal_text_left(segs) -> int:
        return sum(len(x) for x in segs if isinstance(x, str) and tp.is_text(x))

    def conv_str(s: str, where: str) -> str:
        if s.startswith(tp.MARK):
            raise SystemExit(f'string already starts with the marker in {where}')
        if not tp.is_text(s):
            return s
        k_ = tp.h(s)
        if k_ in pool:
            used.add(k_)
            stats['exact'] += len(s)
            return tp.MARK + 'H' + k_
        best = None
        for segs in (split_exact(s), composite(s)):
            if segs and (best is None or literal_text_left(segs) < literal_text_left(best)):
                best = segs
        refined = []
        for x in best or [s]:
            refined.extend(short_match(x) if isinstance(x, str) and tp.is_text(x) else [x])
        best = refined if any(isinstance(x, list) for x in refined) else None
        if best:
            # merge adjacent literals, then decide
            merged = []
            for x in best:
                if isinstance(x, str) and merged and isinstance(merged[-1], str):
                    merged[-1] += x
                else:
                    merged.append(x)
            left = literal_text_left(merged)
            for x in merged:
                if isinstance(x, list):
                    used.add(x[0])
            stats['composite-ref'] += len(s) - left
            if left:
                stats['composite-literal'] += left
                for x in merged:
                    if isinstance(x, str) and tp.is_text(x):
                        literal[x] += 1
                        if len(literal_samples[where]) < 400:
                            literal_samples[where].append(x)
            return tp.MARK + 'C' + json.dumps(merged, ensure_ascii=False, separators=(',', ':'))
        stats['literal'] += len(s)
        literal[s] += 1
        if len(literal_samples[where]) < 400:
            literal_samples[where].append(s)
        return s

    def conv(v, where):
        if isinstance(v, str):
            return conv_str(v, where)
        if isinstance(v, dict):
            return {conv_str(k, where) if isinstance(k, str) else k: conv(x, where) for k, x in v.items()}
        if isinstance(v, list):
            return [conv(x, where) for x in v]
        return v

    templates = {}
    for u in recipe['template']:
        p = GEN / u[len('/gen/'):]
        original = json.loads(p.read_text(encoding='utf-8'))
        t = conv(original, u.split('/')[2])
        # round trip with the full pool must reproduce the original exactly
        if tp.Rehydrator(pool)(t) != original:
            raise SystemExit(f'round trip failed for {u}')
        templates[u] = t
    print(f'templates: {len(templates)} files, {time.time() - t0:.0f}s', flush=True)

    # what the pool on THIS install would miss (older/pruned MasterData)
    missing_here = {k for k in used if origin[k] == 'md-snapshot' and k not in player_md}
    needed_bundles = sorted({bundle_of[k] for k in used if k in bundle_of})
    DATA.mkdir(parents=True, exist_ok=True)
    with gzip.open(DATA / 'templates.json.gz', 'wt', encoding='utf-8') as f:
        json.dump(templates, f, ensure_ascii=False, separators=(',', ':'))
    (DATA / 'text-bundles.json').write_text(json.dumps(needed_bundles, indent=0), encoding='utf-8')
    REPORT.mkdir(parents=True, exist_ok=True)
    with (REPORT / 'literal-report.txt').open('w', encoding='utf-8') as f:
        f.write('Literal strings left in templates (must be explorer wording, not game text)\n\n')
        for s, c in literal.most_common():
            f.write(f'{c:5}  {s[:300]!r}\n')
    summary = {'chars': dict(stats), 'refs': len(used), 'text_bundles': len(needed_bundles),
               'refs_only_in_snapshot_masterdata': len(missing_here), 'distinct_literals': len(literal),
               'template_gz_bytes': (DATA / 'templates.json.gz').stat().st_size, 'seconds': round(time.time() - t0)}
    (REPORT / 'dehydrate-summary.json').write_text(json.dumps(summary, indent=1), encoding='utf-8')
    print(json.dumps(summary))


if __name__ == '__main__':
    main()
