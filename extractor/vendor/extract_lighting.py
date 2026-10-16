# Vendored from explorer/tools/extract_lighting.py by release-tools/sync_vendor.py - do not edit here.
"""Extract the lighting of every Ever Crisis map scene into JSON for the explorer.

Run with the UnityPy environment:
    python tools\\extract_lighting.py [map_key ...]

Reads  02-DecodedBundles/scenes/{dungeon_map,environment}_*.s  (read-only) and writes
generated/lighting/<map_key>.json, in glTF/three.js space (Unity x negated):
  env       the scene's EnvironmentData (dat_env_*): 4-way ambient, fog, saturation/brightness, shadow colour
  render    RenderSettings: fog, ambient, subtractive shadow colour
  lights    realtime/mixed lights (baked ones live in the lightmaps): type, direction, colour, intensity, shadows
  post      post-processing volume components of the profile (Bloom, ...) with their overridden values
  gi        LightingSettings / LightmapSettings flags
"""
import os as _os
from pathlib import Path as _P
import json
import sys
from pathlib import Path

import numpy as np

from extract_dungeon_maps import SCENES, Scene, r

OUT = _P(_os.environ['FFCX_GEN']) / 'lighting'
LIGHT_TYPES = {0: 'spot', 1: 'directional', 2: 'point', 3: 'area'}


def col(c):
    return r([c['r'], c['g'], c['b']])


def plain(v):
    """Typetree value -> JSON: colours as [r,g,b], vectors as lists, PPtrs dropped."""
    if isinstance(v, dict):
        if set(v) >= {'r', 'g', 'b'}:
            return col(v)
        if set(v) == {'x', 'y', 'z'}:
            return r([v['x'], v['y'], v['z']])
        if 'm_PathID' in v:
            return None
        return {k: plain(x) for k, x in v.items() if plain(x) is not None}
    if isinstance(v, float):
        return r(v)
    if isinstance(v, list):
        return None
    return v


def extract(key):
    scene = Scene(SCENES / f'{key}.s')
    data = {'key': key, 'env': None, 'render': None, 'lights': [], 'post': {}, 'gi': {}}
    by_script = {}
    for k, o in scene.objects.items():
        if o.type.name == 'MonoBehaviour':
            by_script.setdefault(scene.script_name(k), []).append((k, scene.tree(k)))

    for k, t in by_script.get('EnvironmentData', []):
        name = t.get('m_Name', '')
        if not name.startswith('dat_env_') or 'camera' in name:
            continue
        env = {a: plain(v) for a, v in t.items() if not a.startswith('m_') and plain(v) is not None}
        data['env'] = env
        prof = scene.ref(k, t.get('profile'))
        if prof in scene.objects:
            for ck in scene.tree(prof).get('components', []):
                c = scene.ref(prof, ck)
                if c not in scene.objects:
                    continue
                ct = scene.tree(c)
                if not ct.get('active', 1):
                    continue
                params = {}
                for a, v in ct.items():
                    if isinstance(v, dict) and 'm_OverrideState' in v:
                        pv = plain(v.get('m_Value'))
                        if pv is not None:
                            params[a] = {'value': pv, 'override': bool(v['m_OverrideState'])}
                data['post'][ct.get('m_Name') or scene.script_name(c)] = params
        break

    for k, o in scene.objects.items():
        tn = o.type.name
        if tn == 'RenderSettings':
            t = scene.tree(k)
            data['render'] = {
                'fog': bool(t.get('m_Fog')), 'fogMode': t.get('m_FogMode'), 'fogColor': col(t['m_FogColor']),
                'fogStart': r(t.get('m_LinearFogStart', 0)), 'fogEnd': r(t.get('m_LinearFogEnd', 0)),
                'fogDensity': r(t.get('m_FogDensity', 0), 6),
                'ambientMode': t.get('m_AmbientMode'), 'ambientIntensity': r(t.get('m_AmbientIntensity', 1)),
                'ambientSky': col(t['m_AmbientSkyColor']), 'ambientEquator': col(t['m_AmbientEquatorColor']),
                'ambientGround': col(t['m_AmbientGroundColor']),
                'subtractiveShadowColor': col(t['m_SubtractiveShadowColor']),
            }
        elif tn == 'LightingSettings':
            t = scene.tree(k)
            data['gi'].update({a: plain(t[a]) for a in ('m_EnableBakedLightmaps', 'm_EnableRealtimeLightmaps',
                                                         'm_IndirectOutputScale', 'm_UsingShadowmask') if a in t})
        elif tn == 'LightmapSettings':
            t = scene.tree(k)
            data['gi']['lightmaps'] = len(t.get('m_Lightmaps', []))
            data['gi']['lightmapsMode'] = t.get('m_LightmapsMode')
        elif tn == 'Light':
            t = scene.tree(k)
            # m_Lightmapping: 4 realtime, 1 mixed, 2 baked (baked lights are only in the lightmaps).
            if not t.get('m_Enabled', 1) or t.get('m_Lightmapping') == 2:
                continue
            go = scene.go_of(k)
            if go not in scene.transform_of:
                continue
            active = scene.tree(go).get('m_IsActive', 1)
            p, rm, _ = scene.world_of_go(go)
            fwd = rm @ np.array([0.0, 0.0, 1.0])
            sh = t.get('m_Shadows', {})
            data['lights'].append({
                'name': scene.go[go]['name'], 'type': LIGHT_TYPES.get(t.get('m_Type'), t.get('m_Type')),
                'active': bool(active), 'mode': {4: 'realtime', 1: 'mixed'}.get(t.get('m_Lightmapping'), t.get('m_Lightmapping')),
                'position': r([-p[0], p[1], p[2]]), 'direction': r([-fwd[0], fwd[1], fwd[2]]),
                'color': col(t['m_Color']), 'intensity': r(t.get('m_Intensity', 1)), 'range': r(t.get('m_Range', 10)),
                'spotAngle': r(t.get('m_SpotAngle', 30)),
                'shadows': {0: 'none', 1: 'hard', 2: 'soft'}.get(sh.get('m_Type', 0)), 'shadowStrength': r(sh.get('m_Strength', 1)),
                'shadowNormalBias': r(sh.get('m_NormalBias', 0.4)),
            })
    data['lights'].sort(key=lambda x: (x['type'] != 'directional', not x['active'], x['name']))
    return data


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    keys = sys.argv[1:] or sorted(p.stem for p in SCENES.glob('*.s')
                                  if p.stem.startswith(('dungeon_map_', 'environment_', 'out_game_environment_')))
    ok = 0
    for key in keys:
        try:
            data = extract(key)
        except Exception as e:
            print(f'! {key}: {type(e).__name__}: {e}')
            continue
        (OUT / f'{key}.json').write_text(json.dumps(data, separators=(',', ':')), encoding='utf-8')
        ok += 1
        print(f'{key}: lights={len(data["lights"])} post={",".join(data["post"])} lightmaps={data["gi"].get("lightmaps")}')
    print(f'done {ok}/{len(keys)}')


if __name__ == '__main__':
    main()
