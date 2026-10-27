# erzeugt public/hand.xml
import pathlib

# Name, x, y, z, Drehung um z (Grad): MCP-Positionen an der CAD-Handflächenkante
FINGERS = [
    ('index',  0.002, -0.008, 0.000,  0),
    ('middle', 0.033, -0.014, 0.000,  0),
    ('ring',   0.065, -0.021, 0.000,  0),
    ('thumb',  0.000, -0.075, -0.030, 90),
]
FLEX_MAX = 90.0   # degree, Grundgelenk
ABD_MAX = 35.0   # degree, Spreizen
PIP_OFFSET = 0.051  # CAD-Abstand zwischen MCP und PIP, Meter
PALM_PARTS = [
    ('palm_shell', 'R-Palm_Shell.stl', '0.30 0.35 0.45 1'),
    ('top_shell', 'R-Top_Shell.stl', '0.38 0.43 0.54 1'),
    ('hand_plate', 'R-Hand_Plate.stl', '0.22 0.26 0.34 1'),
    ('wrist_interface', 'R-Wrist_Interface.stl', '0.26 0.30 0.38 1'),
]
FINGER_PARTS = [
    ('proximal', 'Proximal.stl', '0.82 0.61 0.46 1'),
    ('proximal_shell', 'Proximal_Shell.stl', '0.84 0.70 0.59 1'),
    ('distal', 'Distal.stl', '0.82 0.61 0.46 1'),
    ('distal_shell', 'Distal_Shell.stl', '0.84 0.70 0.59 1'),
]


def finger(name, x, y, z, yaw):
    proximal_geoms = ''.join(
        f"\n      <geom name='{name}_{part}' type='mesh' mesh='{part}' rgba='{rgba}'/>"
        for part, _, rgba in FINGER_PARTS[:2]
    )
    distal_geoms = ''.join(
        f"\n      <geom name='{name}_{part}' type='mesh' mesh='{part}' "
        f"pos='0 {-PIP_OFFSET} 0' rgba='{rgba}'/>"
        for part, _, rgba in FINGER_PARTS[2:]
    )
    return f'''
    <body name='{name}_proximal' pos='{x} {y} {z}' euler='0 0 {yaw}'>
      <joint name='{name}_abd' axis='0 0 1' range='{-ABD_MAX} {ABD_MAX}'/>
      <joint name='{name}_mcp' axis='-1 0 0' range='0 {FLEX_MAX}'/>{proximal_geoms}
      <body name='{name}_distal' pos='0 {PIP_OFFSET} 0'>
        <joint name='{name}_pip' axis='-1 0 0' range='0 {FLEX_MAX}'/>{distal_geoms}
      </body>
    </body>'''


bodies = ''.join(finger(*f) for f in FINGERS)
mesh_assets = ''.join(
    f"\n    <mesh name='{name}' file='meshes/{filename}' scale='0.001 0.001 0.001'/>"
    for name, filename, _ in PALM_PARTS + FINGER_PARTS
)
palm_geoms = ''.join(
    f"\n    <geom name='{name}' type='mesh' mesh='{name}' rgba='{rgba}'/>"
    for name, _, rgba in PALM_PARTS
)

equality = ''
for name, *_ in FINGERS:
    equality += f"""
    <joint joint1='{name}_pip' joint2='{name}_mcp' polycoef='0 1.0 0 0 0'/>"""

# ctrl-Reihenfolge: je Finger erst Beugung, dann Abduktion -> 8 Werte
actuators = ''.join(
    f'''
    <position name='{f[0]}_flex' joint='{f[0]}_mcp' ctrlrange='0 {FLEX_MAX}'/>
    <position name='{f[0]}_abd' joint='{f[0]}_abd' ctrlrange='{-ABD_MAX} {ABD_MAX}'/>'''
    for f in FINGERS)

xml = f'''<mujoco model='four_finger_hand'>
  <option timestep='0.002' integrator='implicitfast'/>
  <default>
    <joint damping='0.01' armature='0.0005'/>
    <geom contype='0' conaffinity='0' rgba='0.85 0.70 0.60 1'/>
    <position kp='0.5' kv='0.02'/>
  </default>
  <asset>{mesh_assets}
  </asset>
  <worldbody>
    <light pos='0 0 0.5'/>
    <body name='hand' pos='0.03 0 0' euler='0 180 0'>{palm_geoms}{bodies}
    </body>
  </worldbody>
  <equality>{equality}
  </equality>
  <actuator>{actuators}
  </actuator>
</mujoco>
'''

pathlib.Path('public').mkdir(exist_ok=True)
pathlib.Path('public/hand.xml').write_text(xml)
print('public/hand.xml geschrieben')