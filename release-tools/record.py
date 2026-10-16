"""Developer tool: fold a finished recording run into extractor/data/recipe.json.

    .venv\\Scripts\\python.exe release-tools\\record.py <run folder> [--partial]

Reads <run>/.ffcx/trace/*.txt (every decoded bundle the converters touched, incl. glob results) -> recipe["decode"],
and <run>/ffcx-manifest.json -> recipe["reference_files"] (size + sha256 of every output, what a player's run is
compared against).

--partial: the run redid only some phases (`ffcx extract --only models,effects,lighting ...` into the folder of an
earlier recording). The decode list keeps the recipe's bundles as well, and files the run did not write keep the
size and hash make_recipe.py gave them instead of being dropped.
"""
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RECIPE = ROOT / 'extractor' / 'data' / 'recipe.json'


def main(run: Path, partial: bool = False):
    recipe = json.loads(RECIPE.read_text(encoding='utf-8'))
    catalog = {b['name'] for b in json.loads((run / '.ffcx' / 'catalog.json').read_text(encoding='utf-8'))['bundles']}
    lower = {n.lower(): n for n in catalog}
    traced = set()
    for t in (run / '.ffcx' / 'trace').glob('trace-*.txt'):
        for line in t.read_text(encoding='utf-8').splitlines():
            name = lower.get(line.strip().lower())
            if name:
                traced.add(name)
    manifest = json.loads((run / 'ffcx-manifest.json').read_text(encoding='utf-8'))
    ref = recipe.get('reference_files', {})
    missing = [u for u in ref if u not in manifest['files']]
    if partial:
        traced |= set(recipe.get('decode', []))
    # gen/anims in the dev tree also holds clips for library models the explorer never loads; the recording run
    # converts exactly the families of the models it built, so those extra clips are dropped from the recipe.
    dropped = [u for u in missing if u.startswith('/gen/anims/')]
    missing = [u for u in missing if not u.startswith('/gen/anims/')]
    recipe['anims'] = [u for u in recipe.get('anims', []) if u not in set(dropped)]
    recipe['decode'] = sorted(traced)
    kept = set(missing) if partial else set()
    recipe['reference_files'] = {u: manifest['files'].get(u) or ref[u] for u in ref if u in manifest['files'] or u in kept}
    recipe['reference'] = {'extractor': manifest['extractor'], 'created': manifest['created'], 'source': manifest['source'],
                           'files': len(manifest['files']), 'bytes': manifest['stats']['bytes']}
    RECIPE.write_text(json.dumps(recipe, separators=(',', ':')), encoding='utf-8')
    print(json.dumps({'decode_bundles': len(traced), 'reference_files': len(recipe['reference_files']),
                      'dropped_unused_anims': len(dropped), 'without_output': len(missing), 'kept_from_make_recipe': len(kept),
                      'sample_missing': missing[:10]}))


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('run', type=Path)
    ap.add_argument('--partial', action='store_true')
    a = ap.parse_args()
    main(a.run, a.partial)
