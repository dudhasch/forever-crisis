# Vendored from converters/pipeline/unity_gltf.py by release-tools/sync_vendor.py - do not edit here.
"""Unity bundle -> glTF 2.0, preserving skins and sampling transform animation.

The archival output retains Unity property metadata. Workshop derivatives are
explicitly lossy: rigid bone parts, <=256px PNG, and rotation-only motion.
"""
import os as _os
from pathlib import Path as _P
import base64, collections, copy, hashlib, io, json, math, re, struct, zlib
from pathlib import Path
import numpy as np
import UnityPy
from UnityPy.helpers.MeshHelper import MeshHandler
from PIL import Image

VERSION = '5'
REFLECT = np.diag([-1.,1.,1.,1.])
IMAGE_CACHE = {}
CAB_INDEX = None
SOURCE_ROOT = None

def safe(name): return re.sub(r'[^A-Za-z0-9_.-]+','_',str(name))[:100] or 'unnamed'
def vec(x, keys='xyz'): return [x[k] for k in keys]
def pos(x): return [-x[0],x[1],x[2]]
def quat(x):
    q=np.array([x[0],-x[1],-x[2],x[3]],dtype=float)
    n=np.linalg.norm(q)
    if n < 1e-10: raise ValueError('Zero quaternion')
    return (q/n).tolist()
def matrix(x): return np.array([[getattr(x,f'e{i}{j}') for j in range(4)] for i in range(4)])
def write_json(path,data):
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(data,ensure_ascii=False,separators=(',',':'),allow_nan=False),encoding='utf8')

class Gltf:
    def __init__(self):
        self.j={'asset':{'version':'2.0','generator':'ffcx unity_gltf '+VERSION},'scene':0,
                'scenes':[{'nodes':[]}],'nodes':[],'bufferViews':[],'accessors':[]}
        self.bin=bytearray();self.textures={}
    def view(self,data):
        self.bin.extend(b'\0'*((-len(self.bin))%4)); at=len(self.bin);self.bin.extend(data)
        v={'buffer':0,'byteOffset':at,'byteLength':len(data)}
        self.j['bufferViews'].append(v);return len(self.j['bufferViews'])-1
    def acc(self,data,kind,component=5126,bounds=False):
        a=np.asarray(data,dtype={5126:'<f4',5125:'<u4',5123:'<u2'}[component])
        if not np.isfinite(a).all(): raise ValueError('Nonfinite accessor')
        count=len(a); a=a.reshape(count,-1)
        if not count: raise ValueError('Empty accessor')
        entry={'bufferView':self.view(a.tobytes()),'componentType':component,'count':count,'type':kind}
        if bounds: entry.update(min=a.min(axis=0).tolist(),max=a.max(axis=0).tolist())
        self.j['accessors'].append(entry);return len(self.j['accessors'])-1
    def save(self,path,glb=False):
        path.parent.mkdir(parents=True,exist_ok=True)
        j=copy.deepcopy(self.j)
        for mesh in j.get('meshes',[]):
            for p in mesh['primitives']:
                for ai in p['attributes'].values():j['bufferViews'][j['accessors'][ai]['bufferView']]['target']=34962
                if 'indices' in p:j['bufferViews'][j['accessors'][p['indices']]['bufferView']]['target']=34963
        if not self.bin:
            j.pop('accessors',None);j.pop('bufferViews',None)
        else:j['buffers']=[{'byteLength':len(self.bin)}]
        if not glb:
            if self.bin:j['buffers'][0]['uri']='data:application/octet-stream;base64,'+base64.b64encode(self.bin).decode()
            write_json(path,j);return
        jb=json.dumps(j,ensure_ascii=False,separators=(',',':'),allow_nan=False).encode();jb+=b' '*((-len(jb))%4)
        bb=bytes(self.bin);bb+=b'\0'*((-len(bb))%4)
        payload=struct.pack('<II',len(jb),0x4e4f534a)+jb
        if bb:payload+=struct.pack('<II',len(bb),0x004e4942)+bb
        path.write_bytes(struct.pack('<III',0x46546c67,2,12+len(payload))+payload)

def hierarchy(objects,g):
    gotrees={o.path_id:o.read_typetree() for o in objects if o.type.name=='GameObject'}
    gos={pid:t['m_Name'] for pid,t in gotrees.items()}
    transforms={o.path_id:o.read_typetree() for o in objects if o.type.name=='Transform'}
    ids={pid:len(g.j['nodes'])+i for i,pid in enumerate(transforms)}
    go_nodes={};paths={}
    def get_path(pid,seen=None):
        if pid in paths:return paths[pid]
        seen=set() if seen is None else seen
        if pid in seen:raise ValueError('Cyclic transform tree')
        seen.add(pid);t=transforms[pid];name=gos.get(t['m_GameObject']['m_PathID'],str(pid))
        parent=t['m_Father']['m_PathID']
        paths[pid]=(get_path(parent,seen)+'/' if parent in transforms else '')+name
        return paths[pid]
    hashes=collections.defaultdict(set)
    for pid,t in transforms.items():
        name=gos.get(t['m_GameObject']['m_PathID'],str(pid));go_nodes[t['m_GameObject']['m_PathID']]=ids[pid]
        path=get_path(pid)
        node={'name':name,'translation':pos(vec(t['m_LocalPosition'])),
              'rotation':quat(vec(t['m_LocalRotation'],'xyzw')),'scale':vec(t['m_LocalScale']),
              'extras':{'unityPath':path,'unityPathId':str(pid)}}
        # Inactive GameObjects (and so their children) are not drawn when the scene loads.
        if not gotrees.get(t['m_GameObject']['m_PathID'],{}).get('m_IsActive',1):node['extras']['unityActive']=False
        children=[ids[c['m_PathID']] for c in t['m_Children'] if c['m_PathID'] in ids]
        if children:node['children']=children
        if t['m_Father']['m_PathID'] not in ids:g.j['scenes'][0]['nodes'].append(ids[pid])
        g.j['nodes'].append(node)
        chunks=path.split('/')
        for i in range(len(chunks)): hashes[zlib.crc32('/'.join(chunks[i:]).encode())].add(ids[pid])
    # A zero hash identifies the animated root when there is exactly one root.
    if len(g.j['scenes'][0]['nodes'])==1:hashes[0].add(g.j['scenes'][0]['nodes'][0])
    return ids,go_nodes,{h:next(iter(v)) for h,v in hashes.items() if len(v)==1}

def resolve(ptr):
    if not ptr or not ptr.m_PathID:return None
    try:return ptr.read()
    except (FileNotFoundError,ValueError,KeyError):
        if ptr.m_FileID and CAB_INDEX and SOURCE_ROOT:
            external=ptr.assetsfile.externals[ptr.m_FileID-1].path.rsplit('/',1)[-1].lower()
            bundle=CAB_INDEX.get(external)
            if bundle:
                ptr.assetsfile.environment.load_file(str(SOURCE_ROOT/'02-DecodedBundles'/bundle),is_dependency=True)
                try:return ptr.read()
                except (FileNotFoundError,ValueError,KeyError):pass
        return None

def ptr_key(ptr):
    """File-independent identity of a PPtr (m_FileID is relative to the file that holds the pointer)."""
    if ptr is None:return None
    f=ptr.assetsfile
    return ((f.externals[ptr.m_FileID-1].path if ptr.m_FileID else f.name).rsplit('/',1)[-1].lower(),ptr.m_PathID)

def embed(g,cachekey,name,make):
    """Texture index of an image embedded once per glTF file; make() -> PNG bytes (cached across files)."""
    if cachekey not in IMAGE_CACHE:IMAGE_CACHE[cachekey]=make()
    if cachekey not in g.textures:
        images=g.j.setdefault('images',[]); images.append({'name':name,'mimeType':'image/png','bufferView':g.view(IMAGE_CACHE[cachekey])})
        textures=g.j.setdefault('textures',[]); textures.append({'source':len(images)-1})
        g.textures[cachekey]=len(textures)-1
    return g.textures[cachekey]

def png(im):
    b=io.BytesIO();im.save(b,format='PNG');return b.getvalue()

def emission(g,spec,texenv,floats,colours,small):
    """EC env shader: _EmissionColor x _EmissionIntensity, masked by the E channel of the MROE map (or _EmissionMap)."""
    c=colours.get('_EmissionColor');power=floats.get('_EmissionIntensity',1.0)
    if c is None or power<=0:return
    rgb=[max(0.,getattr(c,x))*power for x in 'rgb']
    peak=max(rgb)
    if peak<=1e-4:return
    if peak>1:
        spec.setdefault('extensions',{})['KHR_materials_emissive_strength']={'emissiveStrength':peak};rgb=[x/peak for x in rgb]
        used=g.j.setdefault('extensionsUsed',[])
        if 'KHR_materials_emissive_strength' not in used:used.append('KHR_materials_emissive_strength')
    spec['emissiveFactor']=rgb
    for key,channel in (('_EmissionMap',None),('_MetallicGlossMap','A')):
        env=texenv.get(key)
        if not env or not env.m_Texture.m_PathID:continue
        tex=resolve(env.m_Texture)
        if tex is None:continue
        def make():
            im=tex.image.convert('RGBA')
            if channel:
                a=im.getchannel(channel)
                # An all-white mask means the whole surface glows: no texture needed.
                if a.getextrema()[0]>=250:return b''
                im=Image.merge('RGB',(a,a,a))
            if small:im.thumbnail((256,256),Image.Resampling.LANCZOS)
            return png(im)
        cachekey=(tex.object_reader.assets_file.name,tex.object_reader.path_id,small,'emission',channel)
        if cachekey not in IMAGE_CACHE:IMAGE_CACHE[cachekey]=make()
        if not IMAGE_CACHE[cachekey]:break
        spec['emissiveTexture']={'index':embed(g,cachekey,tex.m_Name+('_E' if channel else ''),make)}
        break

def material(g,mat,small=False):
    if mat is None:return None,{'material':'unresolved'}
    tree=mat.object_reader.read_typetree()
    saved=mat.m_SavedProperties
    texenv=dict(saved.m_TexEnvs)
    floats=dict(saved.m_Floats); colours=dict(saved.m_Colors)
    c=colours.get('_BaseColor',colours.get('_Color'))
    factor=[max(0,min(1,getattr(c,x))) for x in 'rgba'] if c else [1,1,1,1]
    spec={'name':mat.m_Name,'pbrMetallicRoughness':{'baseColorFactor':factor,'metallicFactor':0,'roughnessFactor':1},
          'extras':{'unityShaderProperties':tree.get('m_SavedProperties',{})}}
    info={'material':mat.m_Name,'texture':None}
    for key in ('_BaseMap','_MainTex','_BaseColorMap','_AlbedoTex1'):
        env=texenv.get(key)
        if not env or not env.m_Texture.m_PathID:continue
        tex=resolve(env.m_Texture)
        if tex is None:info['unresolved_texture']=key;break
        cachekey=(tex.object_reader.assets_file.name,tex.object_reader.path_id,small)
        def make():
            im=tex.image.convert('RGBA')
            if small:im.thumbnail((256,256),Image.Resampling.LANCZOS)
            return png(im)
        # Shared prop textures are used by several materials: embed each image once per file.
        spec['pbrMetallicRoughness']['baseColorTexture']={'index':embed(g,cachekey,tex.m_Name,make)}
        info['texture']=tex.m_Name;info['original_size']=[tex.m_Width,tex.m_Height]
        info['texture_scale']=[env.m_Scale.x,env.m_Scale.y];info['texture_offset']=[env.m_Offset.x,env.m_Offset.y]
        break
    emission(g,spec,texenv,floats,colours,small)
    if floats.get('_AlphaClip',floats.get('_Alphatest_on',0)) or '_ALPHATEST_ON' in tree.get('m_ValidKeywords',[]):
        spec['alphaMode']='MASK';spec['alphaCutoff']=floats.get('_Cutoff',.5)
    elif floats.get('_Surface',0) or floats.get('_Mode',0) in (2,3) or floats.get('_SrcBlend')==5 or dict(tree.get('stringTagMap',[])).get('RenderType')=='Transparent':spec['alphaMode']='BLEND'
    if floats.get('_Cull',2)==0:spec['doubleSided']=True
    mats=g.j.setdefault('materials',[]);mats.append(spec)
    return len(mats)-1,info

def geometry(g,h,triangles,matidx=None,select=None,transform=None,skin=False,texinfo=None,uv1=None):
    v=np.asarray(h.m_Vertices,dtype=float)[:,:3].copy();v[:,0]*=-1
    normals=np.asarray(h.m_Normals,dtype=float)[:,:3].copy() if h.m_Normals else None
    if normals is not None:normals[:,0]*=-1
    if transform is not None:
        v=(transform@np.column_stack([v,np.ones(len(v))]).T).T[:,:3]
        if normals is not None:normals=(np.linalg.inv(transform[:3,:3]).T@normals.T).T
    tris=np.asarray(triangles,dtype=np.uint32)[:,[0,2,1]]
    if select is None:select=np.arange(len(v))
    else:
        remap=np.full(len(v),-1,dtype=int);remap[select]=np.arange(len(select));tris=remap[tris]
    attrs={'POSITION':g.acc(v[select],'VEC3',bounds=True)}
    if normals is not None:
        n=normals[select]; lens=np.linalg.norm(n,axis=1);n[lens>0]/=lens[lens>0,None];n[lens==0]=[0,1,0]
        attrs['NORMAL']=g.acc(n,'VEC3')
    if h.m_UV0:
        uv=np.asarray(h.m_UV0,dtype=float)[select,:2].copy()
        if texinfo:
            uv=uv*np.array(texinfo.get('texture_scale',[1,1]))+np.array(texinfo.get('texture_offset',[0,0]))
        uv[:,1]=1-uv[:,1];attrs['TEXCOORD_0']=g.acc(uv,'VEC2')
    if uv1 is not None:attrs['TEXCOORD_1']=uv1
    if skin:
        joints=np.zeros((len(v),4),dtype=np.uint16);weights=np.zeros((len(v),4),dtype=float)
        src=np.asarray(h.m_BoneIndices);joints[:,:src.shape[1]]=src
        if h.m_BoneWeights:
            w=np.asarray(h.m_BoneWeights);weights[:,:w.shape[1]]=w
        else:weights[:,0]=1
        weights=np.maximum(weights,0);denom=weights.sum(axis=1)
        weights[denom==0,0]=1;weights/=weights.sum(axis=1)[:,None]
        attrs['JOINTS_0']=g.acc(joints[select],'VEC4',5123);attrs['WEIGHTS_0']=g.acc(weights[select],'VEC4')
    primitive={'attributes':attrs,'indices':g.acc(tris.flatten(),'SCALAR',5125),'mode':4}
    if matidx is not None:primitive['material']=matidx
    return primitive

def lightmap_of(renderer,count):
    """(index, scale-offset) of a baked-lightmapped MeshRenderer; 0xFFFF / 0xFFFE mean no baked lightmap."""
    if renderer is None or not count or renderer.object_reader.type.name!='MeshRenderer':return None
    i=getattr(renderer,'m_LightmapIndex',0xFFFF)
    if i>=count:return None
    st=[renderer.m_LightmapTilingOffset.x,renderer.m_LightmapTilingOffset.y,renderer.m_LightmapTilingOffset.z,renderer.m_LightmapTilingOffset.w]
    if not all(math.isfinite(x) for x in st):return None
    return i,st

def lightmap_uv(g,h,st):
    """Unity's lightmap UV (uv2, else uv) with the renderer's scale/offset, in glTF's flipped V."""
    src=h.m_UV1 if h.m_UV1 else h.m_UV0
    if not src:return None
    uv=np.asarray(src,dtype=float)[:,:2]*np.array(st[:2])+np.array(st[2:])
    # A few stage meshes carry NaN lightmap UVs on unused vertices.
    uv=np.nan_to_num(uv,nan=0.,posinf=0.,neginf=0.)
    uv[:,1]=1-uv[:,1];return g.acc(uv,'VEC2')

def export_models(objects,folder,g,ids,go_nodes,lightmaps=0):
    meshes={o.path_id:o for o in objects if o.type.name=='Mesh'}
    renderers=[];used=set();warnings=[];parts=[]
    # Scene props are MeshFilters whose meshes live in shared environment bundles; resolve() loads those.
    mesh_renderers={}
    for o in objects:
        if o.type.name=='MeshRenderer':
            r=o.read();mesh_renderers.setdefault(r.m_GameObject.m_PathID,r)
    for o in objects:
        if o.type.name=='SkinnedMeshRenderer':
            r=o.read();m=resolve(r.m_Mesh)
            if m is not None:renderers.append((r,m,go_nodes.get(r.m_GameObject.m_PathID)));used.add(r.m_Mesh.m_PathID)
        elif o.type.name=='MeshFilter':
            f=o.read();m=resolve(f.m_Mesh)
            rr=mesh_renderers.get(f.m_GameObject.m_PathID)
            if m is not None:renderers.append((rr,m,go_nodes.get(f.m_GameObject.m_PathID)));used.add(f.m_Mesh.m_PathID)
            elif f.m_Mesh.m_PathID:warnings.append(f'MeshFilter {o.path_id}: unresolved mesh {f.m_Mesh.m_FileID}:{f.m_Mesh.m_PathID}')
    for pid,o in meshes.items():
        if pid not in used:renderers.append((None,o.read(),None))
    mat_cache={};record=[];handlers={};instanced={};parted=set()
    for renderer,m,node in renderers:
        mid=(m.object_reader.assets_file.name,m.object_reader.path_id)
        if mid not in handlers:
            h=MeshHandler(m);h.process();handlers[mid]=h
        h=handlers[mid]
        if not h.m_Vertices: warnings.append(m.m_Name+': empty geometry');continue
        if node is None:
            node=len(g.j['nodes']);g.j['nodes'].append({'name':m.m_Name});g.j['scenes'][0]['nodes'].append(node)
        if renderer is not None:
            # Disabled and shadow-only renderers are never drawn in the game.
            if not getattr(renderer,'m_Enabled',1):g.j['nodes'][node].setdefault('extras',{})['unityRenderer']='disabled'
            elif getattr(renderer,'m_CastShadows',1)==3:g.j['nodes'][node].setdefault('extras',{})['unityRenderer']='shadowsOnly'
        # Rigid props repeat the same mesh+materials hundreds of times: share one glTF mesh.
        mkeys=tuple(ptr_key(p) for p in (renderer.m_Materials if renderer else []))
        ikey=(mid,mkeys)
        rigid=renderer is None or renderer.object_reader.type.name!='SkinnedMeshRenderer'
        lm=lightmap_of(renderer,lightmaps)
        if lm:g.j['nodes'][node].setdefault('extras',{}).update(lightmapIndex=lm[0],lightmapScaleOffset=lm[1])
        if rigid and ikey in instanced:
            base=g.j['meshes'][instanced[ikey]]
            if not lm and not any('TEXCOORD_1' in p['attributes'] for p in base['primitives']):
                g.j['nodes'][node]['mesh']=instanced[ikey];continue
            # Every lightmapped instance has its own atlas rectangle: share all accessors but TEXCOORD_1.
            uv1=lightmap_uv(g,h,lm[1]) if lm else None
            prims=[]
            for p in base['primitives']:
                q=copy.deepcopy(p);q['attributes'].pop('TEXCOORD_1',None)
                if uv1 is not None:q['attributes']['TEXCOORD_1']=uv1
                prims.append(q)
            variant={'name':base['name'],'primitives':prims}
            if uv1 is not None:variant['extras']={'lightmapIndex':lm[0]}
            g.j['meshes'].append(variant);g.j['nodes'][node]['mesh']=len(g.j['meshes'])-1;continue
        uv1=lightmap_uv(g,h,lm[1]) if lm and rigid else None
        bones=getattr(renderer,'m_Bones',[]) if renderer else []
        skin=bool(bones and h.m_BoneIndices and m.m_BindPose and all(b.m_PathID in ids for b in bones))
        if bones and not skin:warnings.append(m.m_Name+': unresolved skeleton')
        bind=[REFLECT@matrix(x)@REFLECT for x in (m.m_BindPose or [])]
        if skin:
            if len(bind)!=len(bones):raise ValueError('Bind matrices and bones differ')
            if max(max(x) for x in h.m_BoneIndices)>=len(bones):raise ValueError('Joint index out of range')
            sk={'joints':[ids[b.m_PathID] for b in bones], 'inverseBindMatrices':g.acc([x.T.flatten() for x in bind],'MAT4')}
            # Unity's culling root need not be a common ancestor of every joint.
            # Let glTF derive the common root instead of copying that culling hint.
            node=len(g.j['nodes']);g.j['nodes'].append({'name':m.m_Name+'__skinned'})
            g.j['scenes'][0]['nodes'].append(node)
            skins=g.j.setdefault('skins',[]);skins.append(sk);g.j['nodes'][node]['skin']=len(skins)-1
        primitives=[];triangle_count=0
        for sub,triangles in enumerate(h.get_triangles()):
            if not triangles:continue
            triangle_count+=len(triangles)
            mp=renderer.m_Materials[min(sub,len(renderer.m_Materials)-1)] if renderer and renderer.m_Materials else None
            mat=resolve(mp);key=ptr_key(mp)
            if key not in mat_cache:mat_cache[key]=material(g,mat)
            mi,info=mat_cache[key]
            if 'unresolved_texture' in info or mat is None:warnings.append(m.m_Name+': unresolved material/texture')
            primitives.append(geometry(g,h,triangles,mi,skin=skin,texinfo=info,uv1=uv1))
            # Segment by the largest total influence across a face; preserve all faces.
            grouped=collections.defaultdict(list)
            if skin:
                jw=np.asarray(h.m_BoneWeights) if h.m_BoneWeights else np.ones((len(h.m_Vertices),1))
                ji=np.asarray(h.m_BoneIndices)
                for tri in triangles:
                    scores=collections.defaultdict(float)
                    for vi in tri:
                        for j,w in zip(ji[vi],jw[vi]):scores[int(j)]+=float(w)
                    grouped[max(scores,key=scores.get)].append(tri)
            else:grouped[None]=triangles
            if (mid,sub) in parted or _os.environ.get('FFCX_NO_WORKSHOP'):continue
            parted.add((mid,sub))
            for bone,tt in grouped.items():
                jointname=g.j['nodes'][ids[bones[bone].m_PathID]]['name'] if bone is not None else 'rigid'
                part=Gltf(); pm,pi=material(part,mat,small=True)
                selected=np.unique(np.asarray(tt).flatten())
                prim=geometry(part,h,tt,pm,selected,bind[bone] if bone is not None else None,texinfo=pi)
                part.j['meshes']=[{'name':m.m_Name,'primitives':[prim]}]
                part.j['nodes']=[{'name':m.m_Name,'mesh':0}];part.j['scenes']=[{'nodes':[0]}]
                part.j['extras']={'derivative':'rigid dominant-bone partition','sourceMesh':m.m_Name,'sourceBone':jointname,'sourceSkinPreserved':False}
                pname=f'{safe(m.m_Name)}_{m.object_reader.path_id}_{sub}_{safe(jointname)}.gltf'
                target=folder/'workshop-parts'/pname;part.save(target)
                parts.append({'file':target.relative_to(folder).as_posix(),'joint':jointname,'vertices':len(selected),'triangles':len(tt)})
        if not primitives:continue
        gm=g.j.setdefault('meshes',[]);gm.append({'name':m.m_Name,'primitives':primitives})
        if uv1 is not None:gm[-1]['extras']={'lightmapIndex':lm[0]}
        g.j['nodes'][node]['mesh']=len(gm)-1
        if rigid:instanced[ikey]=len(gm)-1
        record.append({'name':m.m_Name,'vertices':len(h.m_Vertices),'triangles':triangle_count,'skinned':skin,'bones':len(bones)})
        if getattr(m,'m_Shapes',None) and m.m_Shapes.channels:warnings.append(m.m_Name+': blend shapes retained in Unity source, not exported')
    return record,parts,sorted(set(warnings))

def sample_stream(clip,times):
    stream=clip['m_StreamedClip']; dense=clip['m_DenseClip'];const=clip.get('m_ConstantClip',{}).get('data',[])
    sc=stream['curveCount'];dc=dense['m_CurveCount'];out=np.zeros((len(times),sc+dc+len(const)),dtype=float)
    data=struct.pack('<%dI'%len(stream['data']),*stream['data']);at=0;tracks=collections.defaultdict(list)
    while at<len(data):
        t,n=struct.unpack_from('<fi',data,at);at+=8
        if n<0 or at+n*20>len(data):raise ValueError('Malformed streamed clip')
        for _ in range(n):
            i,a,b,c,d=struct.unpack_from('<i4f',data,at);at+=20
            if i<0 or i>=sc:raise ValueError('Stream curve index out of range')
            tracks[i].append((t,a,b,c,d))
    for i,keys in tracks.items():
        kt=np.array([k[0] for k in keys]); ix=np.clip(np.searchsorted(kt,times,side='right')-1,0,len(keys)-1)
        coeff=np.array(keys)[ix];dt=times-coeff[:,0]
        # Initial and terminal sentinel keys represent a constant endpoint.
        dt[(coeff[:,0]<-1e10)|(coeff[:,0]>1e10)]=0
        out[:,i]=((coeff[:,1]*dt+coeff[:,2])*dt+coeff[:,3])*dt+coeff[:,4]
    if dc:
        arr=np.asarray(dense['m_SampleArray']).reshape(dense['m_FrameCount'],dc)
        dt=dense['m_BeginTime']+np.arange(len(arr))/dense['m_SampleRate']
        for i in range(dc):out[:,sc+i]=np.interp(times,dt,arr[:,i])
    if const:out[:,sc+dc:]=const
    if not np.isfinite(out).all():raise ValueError('Nonfinite sampled animation')
    return out

def export_animation(o,folder,base,hashes):
    d=o.read_typetree();muscle=d.get('m_MuscleClip',{})
    # A motion bundle often holds dozens of complete rigs, one per FBX clip.
    # Resolve hashes inside the clip's own root rather than joining duplicate names.
    candidates=[i for i in base.j['scenes'][0]['nodes'] if base.j['nodes'][i]['name']==d['m_Name']]
    if len(candidates)==1:
        selected=[]
        def descend(i):
            selected.append(i)
            for c in base.j['nodes'][i].get('children',[]):descend(c)
        descend(candidates[0]);remap={old:i for i,old in enumerate(selected)}
        sub=Gltf();sub.j['nodes']=[copy.deepcopy(base.j['nodes'][i]) for i in selected]
        for n in sub.j['nodes']:
            if 'children' in n:n['children']=[remap[c] for c in n['children']]
        sub.j['scenes']=[{'nodes':[0]}];base=sub;hashes={0:0}
        for i,n in enumerate(base.j['nodes']):
            chunks=n.get('extras',{}).get('unityPath',n['name']).split('/')
            for k in range(len(chunks)):hashes[zlib.crc32('/'.join(chunks[k:]).encode())]=i
    clip=muscle.get('m_Clip',{});clip=clip.get('data',clip)
    if not clip or 'm_StreamedClip' not in clip:raise ValueError('Legacy/non-muscle clip needs separate conversion')
    start=muscle['m_StartTime'];stop=muscle['m_StopTime'];duration=stop-start
    if duration<=0:raise ValueError('Animation has zero duration')
    fps=max(1,min(60,d.get('m_SampleRate',30)))
    times=np.linspace(start,stop,max(2,math.ceil(duration*fps)+1));values=sample_stream(clip,times)
    g=Gltf();g.j['nodes']=copy.deepcopy(base.j['nodes']);g.j['scenes']=copy.deepcopy(base.j['scenes'])
    for n in g.j['nodes']:n.pop('mesh',None);n.pop('skin',None)
    anim={'name':d['m_Name'],'channels':[],'samplers':[]};unsupported=[];offset=0;seen=set()
    time_acc=g.acc(times-start,'SCALAR',bounds=True)
    for b in d['m_ClipBindingConstant']['genericBindings']:
        typ=b['typeID'];attr=b['attribute'];width={1:3,2:4,3:3,4:3}.get(attr,1) if typ==4 else 1
        data=values[:,offset:offset+width].copy();offset+=width
        node=hashes.get(b['path'])
        if typ!=4 or attr not in (1,2,3) or node is None:
            unsupported.append({'type':typ,'attribute':attr,'pathHash':b['path']});continue
        if data.shape[1]!=width:raise ValueError('Animation binding exceeds sample width')
        path={1:'translation',2:'rotation',3:'scale'}[attr]
        if (node,path) in seen:raise ValueError('Duplicate animation channel')
        seen.add((node,path))
        if attr==1:data[:,0]*=-1
        if attr==2:
            data[:,1:3]*=-1;length=np.linalg.norm(data,axis=1)
            if (length<1e-8).any():raise ValueError('Zero rotation key')
            data/=length[:,None]
            for i in range(1,len(data)):
                if np.dot(data[i-1],data[i])<0:data[i]*=-1
        acc=g.acc(data,'VEC4' if attr==2 else 'VEC3')
        anim['channels'].append({'sampler':len(anim['samplers']),'target':{'node':node,'path':path}})
        anim['samplers'].append({'input':time_acc,'output':acc,'interpolation':'LINEAR'})
    if offset!=values.shape[1]:raise ValueError(f'Binding width {offset} != curves {values.shape[1]}')
    if not anim['channels']:raise ValueError('No resolved transform channels')
    name=f'{safe(d["m_Name"])}_{o.path_id}'
    g.j['animations']=[anim];g.j['extras']={'unityEvents':d.get('m_Events',[]),'unityLoop':muscle.get('m_LoopTime'),
        'sampleRate':fps,'sampled':True,'unconvertedBindings':unsupported,'sourceStart':start}
    full=folder/(name+'.gltf');g.save(full)
    rotations=copy.deepcopy(anim);rotations['channels']=[c for c in rotations['channels'] if c['target']['path']=='rotation']
    workshop=None
    if rotations['channels'] and duration<=120 and not _os.environ.get('FFCX_NO_WORKSHOP'):
        g.j['animations']=[rotations];g.j['extras']['derivative']='rotation-only; translation and scale removed'
        workshop=folder/(name+'.workshop.gltf');g.save(workshop)
    return {'name':d['m_Name'],'file':full.name,'workshop_file':workshop.name if workshop else None,
        'seconds':duration,'frames':len(times),'channels':len(anim['channels']),'unsupported_bindings':unsupported,
        'rotation_channels':len(rotations['channels'])}

# Texture2D.m_LightmapFormat (TextureUsageMode) -> how the shader decodes the texel.
LIGHTMAP_ENCODING={1:'dLDR',2:'RGBM',5:'RGBM',7:'dLDR',8:'dLDR',9:'RGBM',10:'HDR',11:'RGBM'}

def export_lightmaps(objects,g):
    """Scene lightmaps (LightmapSettings) as raw RGBA PNGs. glTF has no lightmap slot: the root extras list them and
    each lightmapped node carries lightmapIndex; its TEXCOORD_1 already has the atlas scale/offset applied."""
    out=[]
    for o in objects:
        if o.type.name!='LightmapSettings':continue
        for d in o.read().m_Lightmaps:
            tex=resolve(d.m_Lightmap)
            if tex is None:out.append(None);continue
            cachekey=(tex.object_reader.assets_file.name,tex.object_reader.path_id,'lightmap')
            idx=embed(g,cachekey,tex.m_Name,lambda:png(tex.image.convert('RGBA')))
            out.append({'texture':idx,'name':tex.m_Name,'encoding':LIGHTMAP_ENCODING.get(getattr(tex,'m_LightmapFormat',0),'LDR'),
                        'size':[tex.m_Width,tex.m_Height]})
        break
    # A missing lightmap in the middle keeps its slot (None) so the indices still line up.
    while out and out[-1] is None:out.pop()
    return out

def convert(source,bundle,out):
    global CAB_INDEX,SOURCE_ROOT
    SOURCE_ROOT=Path(source)
    if CAB_INDEX is None:
        cp=_P(_os.environ['FFCX_CAB_INDEX'])
        CAB_INDEX=json.loads(cp.read_text(encoding='utf8')) if cp.exists() else {}
    IMAGE_CACHE.clear()
    folder=Path(out)/Path(bundle).with_suffix('')
    marker=folder/'conversion.json'
    if marker.exists():
        result=json.loads(marker.read_text(encoding='utf8'))
        if result.get('converter_version')==VERSION and result.get('status')=='converted':return result
    env=UnityPy.load(str(Path(source)/'02-DecodedBundles'/bundle));objects=list(env.objects)
    g=Gltf();ids,gos,hashes=hierarchy(objects,g)
    report={'bundle':bundle,'converter_version':VERSION,'status':'converted','models':[],'parts':[],'animations':[],'warnings':[]}
    if any(o.type.name in ('Mesh','MeshFilter','SkinnedMeshRenderer') for o in objects):
        lightmaps=export_lightmaps(objects,g)
        report['models'],report['parts'],report['warnings']=export_models(objects,folder,g,ids,gos,len(lightmaps))
        if report['models']:
            g.j['extras']={'sourceBundle':bundle,'basis':'Unity X reflected; Y up; units unchanged'}
            if lightmaps:g.j['extras']['lightmaps']=lightmaps;report['lightmaps']=len(lightmaps)
            g.save(folder/'model.glb',glb=True);report['model_file']='model.glb'
    motionbase=g;motionhashes=hashes
    if any(o.type.name=='AnimationClip' for o in objects) and not hashes:
        # Controller bundles refer to the character's model skeleton without copying it.
        parent=(Path(source)/'02-DecodedBundles'/bundle).parent
        candidates=sorted((parent/'model').glob('*.d'))
        if candidates:
            reference=UnityPy.load(str(candidates[0]));motionbase=Gltf()
            _,_,motionhashes=hierarchy(list(reference.objects),motionbase)
            report['animation_skeleton_source']=candidates[0].relative_to(Path(source)/'02-DecodedBundles').as_posix()
    for o in objects:
        if o.type.name=='AnimationClip':
            try:report['animations'].append(export_animation(o,folder,motionbase,motionhashes))
            except Exception as e:report['warnings'].append(f'AnimationClip {o.path_id}: {type(e).__name__}: {e}')
    if not report['models'] and not report['animations']:report['status']='needs_conversion'
    write_json(marker,report);return report

