"""Clone the game's unlit shader for Mort's alpha-cutout fur/whisker cards.
Only Mort's material uses it. Both shipped GLES 2/3 program strings are patched;
vertex programs, binding metadata, depth writes and other materials are retained.
"""
import copy
import struct
from UnityPy.helpers import CompressionHelper
from UnityPy.streams import EndianBinaryReader

NAME = 'Mort/V2Cutout'

def patch_subprogram(data):
    reader = EndianBinaryReader(data, endian='<')
    version = reader.read_int(); reader.read_int(); reader.Position += 12
    if version >= 201608170: reader.Position += 4
    for _ in range(reader.read_int()): reader.read_aligned_string()
    if 201806140 <= version < 202012090:
        for _ in range(reader.read_int()): reader.read_aligned_string()
    length_pos = reader.Position
    code = reader.read_byte_array(); reader.align_stream(); tail = reader.Position
    text = code.decode('utf8')
    if '#ifdef FRAGMENT' not in text: return data, 0
    if 'texture(_MainTex, vs_TEXCOORD0.xy).xyz' in text:
        text = text.replace('    u_xlat10_0.xyz = texture(',
                            '    if (texture(_MainTex, vs_TEXCOORD0.xy).a < 0.25) discard;\n    u_xlat10_0.xyz = texture(', 1)
    elif 'col_1.xyz = texture2D' in text:
        text = text.replace('  col_1.xyz = texture2D',
                            '  if (texture2D(_MainTex, xlv_TEXCOORD0).a < 0.25) discard;\n  col_1.xyz = texture2D', 1)
    else: raise AssertionError('Unexpected Mort shader program')
    code = text.encode('utf8')
    result = data[:length_pos] + struct.pack('<I', len(code)) + code
    result += b'\0' * (-len(result) % 4)
    return result + data[tail:], 1

def cutout_shader(sa):
    for obj in sa.objects.values():
        if obj.type.name == 'Shader' and obj.read().m_Name == NAME: return obj.path_id
    source = sa.objects[67]
    data = source.read_typetree()
    assert data['m_ParsedForm']['m_Name'] == 'Unlit/Texture'
    data['m_Name'] = data['m_ParsedForm']['m_Name'] = NAME
    for sub in data['m_ParsedForm']['m_SubShaders']:
        for shader_pass in sub['m_Passes']:
            shader_pass['m_State']['culling']['val'] = 0.0
    old_blob = bytes(data['compressedBlob']); blob = bytearray(); patched = 0
    for i, (offset, size, uncompressed) in enumerate(zip(data['offsets'], data['compressedLengths'], data['decompressedLengths'])):
        raw = CompressionHelper.decompress_lz4(old_blob[offset:offset + size], uncompressed)
        count = struct.unpack_from('<I', raw)[0]
        entries = []
        for j in range(count):
            start, length = struct.unpack_from('<II', raw, 4 + j * 8)
            program, changed = patch_subprogram(raw[start:start + length])
            entries.append(program); patched += changed
        rebuilt = bytearray(struct.pack('<I', count)); position = 4 + count * 8
        for program in entries:
            rebuilt += struct.pack('<II', position, len(program)); position += len(program)
        rebuilt += b''.join(entries)
        compressed = CompressionHelper.compress_lz4(rebuilt)
        data['offsets'][i] = len(blob); data['compressedLengths'][i] = len(compressed); data['decompressedLengths'][i] = len(rebuilt)
        blob += compressed
    assert patched == 2, patched
    data['compressedBlob'] = bytes(blob)
    pid = max(sa.objects) + 1
    obj = copy.copy(source); obj.path_id = pid; obj.data = None
    sa.objects[pid] = obj; obj.save_typetree(data)
    return pid
