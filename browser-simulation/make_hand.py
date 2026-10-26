# erzeugt public/hand.xml
import pathlib

# Name, x, y, Drehung um z (Grad), Länge proximal, Länge distal (Meter)
# Reihenfolge wie die Servo-Paare der Amazing Hand: Index, Mittel, Ring, Daumen
FINGERS = [
    ('index',  -0.027,  0.045,  0, 0.045, 0.035),
    ('middle',  0.000,  0.047,  0, 0.050, 0.038),
    ('ring',    0.027,  0.045,  0, 0.046, 0.036),
    ('thumb',  -0.045, -0.010, 55, 0.040, 0.032),
]
FLEX_MAX = 1.6   # rad, Grundgelenk
ABD_MAX = 0.35   # rad, Spreizen (ca. 20 Grad)
COUPLING = 0.9   # Endgelenk = 0.9 * Grundgelenk


def finger(name, x, y, yaw, l1, l2):
    return f'''
    <body name='{name}_prox' pos='{x} {y} 0' euler='0 0 {yaw}'>
      <joint name='{name}_abd' axis='0 0 1' range='{-ABD_MAX} {ABD_MAX}'/>
      <joint name='{name}_mcp' axis='-1 0 0' range='0 {FLEX_MAX}'/>
      <geom type='capsule' fromto='0 0 0 0 {l1} 0' size='0.0085'/>
      <body name='{name}_dist' pos='0 {l1} 0'>
        <joint name='{name}_pip' axis='-1 0 0' range='0 1.5'/>
        <geom type='capsule' fromto='0 0 0 0 {l2} 0' size='0.0075'/>
      </body>
    </body>'''


bodies = ''.join(finger(*f) for f in FINGERS)

equality = ''.join(
    f'''
    <joint joint1='{f[0]}_pip' joint2='{f[0]}_mcp' polycoef='0 {COUPLING} 0 0 0'/>'''
    for f in FINGERS)

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
  <worldbody>
    <light pos='0 0 0.5'/>
    <geom name='palm' type='box' size='0.045 0.045 0.010' rgba='0.30 0.35 0.45 1'/>{bodies}
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