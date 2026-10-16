# Vendored from explorer/tools/extract_skyboxes.py by release-tools/sync_vendor.py - do not edit here.
"""Export the skybox cubemaps of Ever Crisis 3D stages for the explorer.

Run with the UnityPy environment:
    python tools\\extract_skyboxes.py

Reads (read-only)
  02-DecodedBundles/environment/common/skybox/materials/mat_env_skybox_*.a   Skybox/Cubemap materials
  02-DecodedBundles/environment/common/skybox/materials/tex_env_skybox_*.a   their DXT5 cubemaps
  02-DecodedBundles/scenes/*.s                                               RenderSettings.m_SkyboxMaterial
Writes
  generated/sky/<cubemap>/{px,nx,py,ny,pz,nz}.jpg   faces in Unity order (+X -X +Y -Y +Z -Z)
  generated/sky/index.json                          { skyboxes: {material: {...}}, maps: {map_key: material} }

The faces stay in Unity's (left-handed) cube convention. Sample them in a shader with the Unity-space
direction, i.e. (-x, y, z) of a three.js/glTF direction.
"""
import os as _os
from pathlib import Path as _P
import json
import sys
from pathlib import Path

import UnityPy
from UnityPy.export import Texture2DConverter
from UnityPy.helpers import ResourceReader

sys.path.insert(0, str(Path(__file__).resolve().parent))
from extract_dungeon_maps import SCENES, Scene  # noqa: E402

ARCHIVE = _P(_os.environ['FFCX_ARCHIVE'])
SKY = ARCHIVE / '02-DecodedBundles' / 'environment' / 'common' / 'skybox' / 'materials'
OUT = _P(_os.environ['FFCX_GEN']) / 'sky'
FACES = ['px', 'nx', 'py', 'ny', 'pz', 'nz']


def materials():
    """Material path id -> skybox parameters (path ids are stable across bundles)."""
    out = {}
    for f in sorted(SKY.glob('mat_env_skybox_*.a')):
        env = UnityPy.load(str(f))
        for o in env.objects:
            if o.type.name != 'Material':
                continue
            t = o.read_typetree()
            sp = t['m_SavedProperties']
            tex = dict(sp['m_TexEnvs']).get('_Tex', {}).get('m_Texture', {})
            floats = dict(sp['m_Floats'])
            tint = dict(sp['m_Colors']).get('_Tint', {'r': 0.5, 'g': 0.5, 'b': 0.5})
            out[o.path_id] = {'name': t['m_Name'], 'texture': tex.get('m_PathID'),
                              'exposure': floats.get('_Exposure', 1.0), 'rotation': floats.get('_Rotation', 0.0),
                              'tint': [tint['r'], tint['g'], tint['b']]}
    return out


def cubemaps():
    """Cubemap path id -> (bundle path, name)."""
    out = {}
    for f in sorted(SKY.glob('tex_env_skybox_*.a')):
        env = UnityPy.load(str(f))
        for o in env.objects:
            if o.type.name == 'Cubemap':
                out[o.path_id] = (f, o.read().m_Name)
    return out


def export_cubemap(bundle, path_id, name):
    folder = OUT / name
    if all((folder / f'{face}.jpg').exists() for face in FACES):
        return True
    env = UnityPy.load(str(bundle))
    obj = next(o for o in env.objects if o.path_id == path_id)
    tex = obj.read()
    data = tex.image_data
    if not data:  # pixels live in the bundle's .resS stream
        sd = tex.m_StreamData
        data = ResourceReader.get_resource_data(sd.path, obj.assets_file, sd.offset, sd.size)
    n = len(data) // 6
    folder.mkdir(parents=True, exist_ok=True)
    for i, face in enumerate(FACES):
        img = Texture2DConverter.parse_image_data(
            data[i * n:(i + 1) * n], tex.m_Width, tex.m_Height, tex.m_TextureFormat,
            obj.assets_file.version, obj.assets_file.target_platform, getattr(tex, "m_PlatformBlob", None), flip=False)
        img.convert('RGB').save(folder / f'{face}.jpg', quality=90)
    return True


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    mats = materials()
    cubes = cubemaps()
    print(f'{len(mats)} skybox materials, {len(cubes)} cubemaps')
    keys = sys.argv[1:] or sorted(p.stem for p in SCENES.glob('*.s')
                                  if p.stem.startswith(('environment_', 'out_game_environment_', 'dungeon_map_')))
    index = {'skyboxes': {}, 'maps': {}}
    for key in keys:
        try:
            scene = Scene(SCENES / f'{key}.s')
        except Exception as e:  # pragma: no cover - diagnostic
            print(f'! {key}: {e}')
            continue
        pid = None
        for k, o in scene.objects.items():
            if o.type.name == 'RenderSettings':
                pid = (scene.tree(k).get('m_SkyboxMaterial') or {}).get('m_PathID')
        mat = mats.get(pid)
        if not mat:
            continue
        cube = cubes.get(mat['texture'])
        if not cube:
            print(f'  {key}: {mat["name"]} has no cubemap bundle')
            continue
        export_cubemap(cube[0], mat['texture'], cube[1])
        index['skyboxes'][mat['name']] = {
            'faces': [f'/gen/sky/{cube[1]}/{face}.jpg' for face in FACES],
            'exposure': mat['exposure'], 'rotation': mat['rotation'], 'tint': mat['tint']}
        index['maps'][key] = mat['name']
        print(f'{key}: {mat["name"]} -> {cube[1]}')
    (OUT / 'index.json').write_text(json.dumps(index, indent=1), encoding='utf-8')
    print(f'done: {len(index["maps"])} maps with a skybox, {len(index["skyboxes"])} skyboxes')


if __name__ == '__main__':
    main()
