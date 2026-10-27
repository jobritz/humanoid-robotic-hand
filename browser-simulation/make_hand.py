# erzeugt public/hand.xml
import pathlib

# Name, x, y, Drehung um z (Grad), Länge proximal, Länge distal (Meter)
# Reihenfolge wie die Servo-Paare der Amazing Hand: Index, Mittel, Ring, Daumen
FINGERS = [
    ('index',  -0.027,  0.045,  0, (0.032, 0.022, 0.018)),
    ('middle',  0.000,  0.047,  0, (0.035, 0.025, 0.019)),
    ('ring',    0.027,  0.045,  0, (0.032, 0.023, 0.018)),
    ('thumb',  -0.045, -0.010, 55, (0.040, 0.032)),
]
FLEX_MAX = 90.0   # degree, Grundgelenk
ABD_MAX = 35.0   # degree, Spreizen
JOINTS = ['mcp', 'pip', 'dip']


def finger(name, x, y, yaw, lens):
    xml = ''
    for i in reversed(range(len(lens))):       # von der Spitze nach innen verschachteln
        j = JOINTS[i]
        l = lens[i]
        if i == 0:
            head = f"pos='{x} {y} 0' euler='0 0 {yaw}'"
            abd = f"<joint name='{name}_abd' axis='0 0 1' range='{-ABD_MAX} {ABD_MAX}'/>"
            rng = FLEX_MAX
        else:
            head = f"pos='0 {lens[i - 1]} 0'"
            abd = ''
            rng = FLEX_MAX #* (0.9 if name == 'thumb' and j == 'pip' else 0.67)  # pip = 1.0*mcp, dip = 0.67*pip, Daumen: pip = 0.9*mcp
        xml = f'''
    <body name='{name}_{i}' {head}>
      {abd}
      <joint name='{name}_{j}' axis='-1 0 0' range='0 {rng}'/>
      <geom type='capsule' fromto='0 0 0 0 {l} 0' size='{0.0085 - 0.0005 * i}'/>{xml}
    </body>'''
    return xml


bodies = ''.join(finger(*f) for f in FINGERS)

equality = ''
for name, _, _, _, lens in FINGERS:
    # Dreigliedrig: pip = 1.0*mcp, dip = 0.67*pip. Daumen: pip = 0.9*mcp.
    for j, parent, c in (('pip', 'mcp', 1.0 if len(lens) == 3 else 0.9), ('dip', 'pip', 0.67)):
        if JOINTS.index(j) < len(lens):
            equality += f'''
    <joint joint1='{name}_{j}' joint2='{name}_{parent}' polycoef='0 {c} 0 0 0'/>'''

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