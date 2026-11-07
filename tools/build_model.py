#!/usr/bin/env python3
"""
Baut ein MuJoCo-Modell: LeRobot SO-101 (Follower) + Amazing Hand (rechts, Pollen Robotics).

Quellen:
  - SO-101 MJCF:  TheRobotStudio/SO-ARM100  Simulation/SO101/so101_new_calib.xml
  - Hand MJCF:    pollen-robotics/AmazingHand  Demo/AHSimulation/AHSimulation/AH_Right/mjcf/robot.xml
  - Adapter:      pollen-robotics/AmazingHand  cad/stl/SO-ARM_Interface.stl

Aufruf:
  python build_model.py <src_dir> <out_dir> [--mount-deg 0]
"""
import argparse
import os
import shutil

import mujoco
import numpy as np
import trimesh
from scipy.spatial.transform import Rotation as R

# --------------------------------------------------------------------------------------
# Parameter (alles Schätzwerte, siehe README)
# --------------------------------------------------------------------------------------
HAND_TOTAL_MASS = 0.400          # kg, Angabe Pollen README ("400g weight")
SCS0009_MASS = 0.013             # kg pro Servo (Schätzung)
PLA_DENSITY = 1240 * 0.6         # kg/m^3, PLA mit ~60 % effektiver Füllung
TPU_DENSITY = 1210               # kg/m^3, Shells (dünnwandig, voll gedruckt)

# SCS0009: ~0.23 Nm Stall-Torque @6V, ~0.1 s/60° Leerlaufgeschwindigkeit
SERVO = dict(kp=2.0, kv=0.03, forcerange=0.23, damping=0.02, armature=5e-4, frictionloss=0.01)

FINGERS = {1: "index", 2: "middle", 3: "ring", 4: "thumb"}

# Hornfläche des Wrist-Roll-Servos im SO-101-Body "gripper" (aus den Meshes bestimmt):
# Fläche bei z=0, Lochbild-Mitte (4x M3 auf 9,9 mm Quadrat) bei (-0.41, -0.01) mm
HORN_CENTER_G = np.array([-0.00041, -0.00001, 0.0])
# Gleiches Lochbild am Adapter (STL-Koordinaten in mm), Hornseite z=108.2
HORN_CENTER_A = np.array([24.5, -11.51, 108.2]) * 1e-3


def T(pos, quat_wxyz):
    M = np.eye(4)
    M[:3, :3] = R.from_quat(quat_wxyz, scalar_first=True).as_matrix()
    M[:3, 3] = pos
    return M


def pq(M):
    return M[:3, 3].copy(), R.from_matrix(M[:3, :3]).as_quat(scalar_first=True)


def mesh_mass_props(path, scale, M, density=None, mass=None):
    """Masse, Schwerpunkt, Trägheitstensor (um Schwerpunkt) eines Meshes im Body-Frame."""
    m = trimesh.load(path)
    m.apply_scale(scale)
    m.apply_transform(M)
    vol = abs(m.volume)
    mass = mass if mass is not None else vol * density
    com = m.center_mass
    I = m.moment_inertia * (mass / (vol * m.density))  # trimesh: density=1 default
    return mass, com, I


def combine(props):
    mt = sum(p[0] for p in props)
    com = sum(p[0] * p[1] for p in props) / mt
    I = np.zeros((3, 3))
    for m, c, Ic in props:
        d = c - com
        I += Ic + m * (np.dot(d, d) * np.eye(3) - np.outer(d, d))
    return mt, com, I


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("out")
    ap.add_argument("--mount-deg", type=float, default=270.0,
                    help="Montagewinkel der Hand auf dem Horn (Vielfache von 90°)")
    a = ap.parse_args()

    hand_dir = os.path.join(a.src, "AmazingHand/Demo/AHSimulation/AHSimulation/AH_Right/mjcf")
    cad_dir = os.path.join(a.src, "AmazingHand/cad/stl")
    arm_dir = os.path.join(a.src, "SO-ARM100/Simulation/SO101")
    out = a.out
    assets = os.path.join(out, "assets")
    if os.path.exists(out):
        shutil.rmtree(out)
    os.makedirs(assets)

    # ---------------------------------------------------------------- assets kopieren
    for d in (os.path.join(arm_dir, "assets"), os.path.join(hand_dir, "assets")):
        for f in os.listdir(d):
            if f.lower().endswith(".stl"):
                shutil.copy(os.path.join(d, f), assets)
    extra = {
        "so_arm_interface.stl": "SO-ARM_Interface.stl",
        "r_palm_shell.stl": "Amazing Hand Parts - R-Palm_Shell.stl",
        "r_top_shell.stl": "Amazing Hand Parts - R-Top_Shell.stl",
    }
    for dst, src in extra.items():
        m = trimesh.load(os.path.join(cad_dir, src))
        m.apply_scale(1e-3)  # mm -> m
        m.export(os.path.join(assets, dst))

    shutil.copy(os.path.join(hand_dir, "robot.xml"), os.path.join(out, "_hand_src.xml"))
    shutil.copy(os.path.join(arm_dir, "so101_new_calib.xml"), os.path.join(out, "_arm_src.xml"))
    hand = mujoco.MjSpec.from_file(os.path.join(out, "_hand_src.xml"))
    arm = mujoco.MjSpec.from_file(os.path.join(out, "_arm_src.xml"))

    # ================================================================ HAND
    palm = hand.body("r_wrist_interface")
    palm.name = "palm"

    jmap, smap = {}, {}

    def rn_joint(j, new):
        jmap[j.name] = new
        j.name = new

    for i, f in FINGERS.items():
        j1 = hand.joint(f"finger{i}_motor1")
        j2 = hand.joint(f"finger{i}_motor2")
        horn1, horn2 = j1.parent, j2.parent
        rod1 = horn1.first_body()
        link = rod1.first_body()
        rod2 = horn2.first_body()
        kids = list(link.bodies)
        gimbal = next(b for b in kids if b.first_joint().name.startswith("passive2"))
        distal = next(b for b in kids if b.first_joint().name.startswith("passive4"))
        prox = distal.first_body()

        for b, n in [(horn1, "horn1"), (horn2, "horn2"), (rod1, "rod1"), (rod2, "rod2"),
                     (link, "link"), (gimbal, "gimbal"), (distal, "distal"), (prox, "proximal")]:
            b.name = f"{f}_{n}"
        rn_joint(j1, f"{f}_motor1")
        rn_joint(j2, f"{f}_motor2")
        for b, n in [(rod1, "rod1_ball"), (rod2, "rod2_ball"), (link, "link_ball"),
                     (gimbal, "gimbal_hinge"), (distal, "distal_hinge"), (prox, "proximal_hinge")]:
            rn_joint(b.first_joint(), f"{f}_{n}")

        # Passive Gelenke (Kugelgelenke, Stifte): Original-Default frictionloss=0.1 Nm
        # pro Gelenk blockiert die SCS0009 (0.23 Nm) -> kleine, realistische Werte
        for b in (rod1, rod2, link, gimbal, distal, prox):
            pj = b.first_joint()
            pj.frictionloss = 0.002
            pj.armature = 1e-5
            pj.damping = [0.002, 0, 0]

        # Motorgelenke: SCS0009-Parameter
        for j in (j1, j2):
            j.damping = [SERVO["damping"], 0, 0]
            j.armature = SERVO["armature"]
            j.frictionloss = SERVO["frictionloss"]

        # Kollisionsgeometrie: TPU-Shells der Phalangen (konvexe Hüllen)
        for b in (prox, distal):
            for g in list(b.geoms):
                if g.meshname in ("proximal_shell", "distal_shell", "prox_shell", "dist_shell"):
                    b.add_geom(name=f"{b.name}_col", type=mujoco.mjtGeom.mjGEOM_MESH,
                               meshname=g.meshname, pos=g.pos, quat=g.quat,
                               contype=1, conaffinity=1, group=3, condim=4,
                               friction=[1.0, 0.01, 0.0001], rgba=[0.9, 0.4, 0.2, 0.5])
                    break
        tip = hand.site(f"tip{i}")
        tip.name = f"{f}_tip"

    # Sites ohne Leer-/Sonderzeichen
    for s in list(hand.sites):
        new = s.name.replace(" (", "_f").replace(")", "")
        smap[s.name] = new
        s.name = new
    for e in hand.equalities:
        e.name1 = smap.get(e.name1, e.name1)
        e.name2 = smap.get(e.name2, e.name2)

    # Aktuatoren: Namen + SCS0009-Regler
    for act in hand.actuators:
        f = FINGERS[int(act.name[6])]
        act.name = f"{f}_{act.name.split('_')[1]}"
        act.target = jmap[act.target]
        act.set_to_position(kp=SERVO["kp"], kv=SERVO["kv"])
        act.forcelimited = mujoco.mjtLimited.mjLIMITED_TRUE
        act.forcerange = [-SERVO["forcerange"], SERVO["forcerange"]]
        act.classname = hand.default  # Klasse "mjcf" (kp=50) nicht mehr verwenden
        act.inheritrange = 0
        act.ctrllimited = mujoco.mjtLimited.mjLIMITED_TRUE
        act.ctrlrange = [-np.pi / 2, np.pi / 2]  # = Gelenkbereich der Motoren

    # Palm- und Top-Shell (fehlen im Original-MJCF), gleicher CAD-Frame wie Handplatte
    plate = next(g for g in palm.geoms if g.meshname == "r_hand_plate")
    for nm, rgba in (("r_palm_shell", [1, 1, 1, 1]), ("r_top_shell", [0.95, 0.95, 0.95, 1])):
        hand.add_mesh(name=nm, file=f"{nm}.stl")
        palm.add_geom(name=f"{nm}_visual", type=mujoco.mjtGeom.mjGEOM_MESH, meshname=nm,
                      pos=plate.pos, quat=plate.quat, contype=0, conaffinity=0, group=2,
                      rgba=rgba)
        palm.add_geom(name=f"{nm}_col", type=mujoco.mjtGeom.mjGEOM_MESH, meshname=nm,
                      pos=plate.pos, quat=plate.quat, contype=1, conaffinity=1, group=3,
                      condim=4, friction=[1.0, 0.01, 0.0001], rgba=[0.9, 0.4, 0.2, 0.5])

    # Massenträgheit der Handfläche (im Original 1e-9 kg)
    props = []
    for g in palm.geoms:
        if g.type != mujoco.mjtGeom.mjGEOM_MESH or g.contype:  # nur Visual-Geoms zählen
            continue
        M = T(g.pos, g.quat)
        path = os.path.join(assets, f"{g.meshname}.stl")
        if g.meshname == "scs0009":
            props.append(mesh_mass_props(path, 1.0, M, mass=SCS0009_MASS))
        elif "shell" in g.meshname:
            props.append(mesh_mass_props(path, 1.0, M, density=TPU_DENSITY))
        else:
            props.append(mesh_mass_props(path, 1.0, M, density=PLA_DENSITY))
    m_raw, com, I = combine(props)

    tmp = hand.copy()
    tmp.body("palm").explicitinertial = True
    tmp.body("palm").mass = 1e-9
    moving = float(tmp.compile().body_subtreemass[1]) - 1e-9
    m_palm = HAND_TOTAL_MASS - moving
    I *= m_palm / m_raw
    palm.explicitinertial = True
    palm.mass = m_palm
    palm.ipos = com
    palm.fullinertia = [I[0, 0], I[1, 1], I[2, 2], I[0, 1], I[0, 2], I[1, 2]]
    palm.add_site(name="palm_center", pos=[0.014, -0.007, 0.075], size=[0.004, 0, 0], group=4,
                  rgba=[0, 1, 0, 0.6])
    print(f"Hand: bewegte Teile {moving*1000:.1f} g, Handfläche {m_palm*1000:.1f} g "
          f"(Rohschätzung aus CAD {m_raw*1000:.1f} g)")

    # Selbstkollisionen: Handfläche <-> Fingerglieder ausschließen (konvexe Hüllen überlappen)
    for f in FINGERS.values():
        for part in ("proximal", "distal"):
            hand.add_exclude(bodyname1="palm", bodyname2=f"{f}_{part}")

    # ================================================================ ARM
    grip = arm.body("gripper")
    arm.delete(arm.body("moving_jaw_so101_v1"))
    for g in list(grip.geoms):
        arm.delete(g)
    for s in list(grip.sites):
        arm.delete(s)
    if arm.actuator("gripper") is not None:  # wird ggf. mit dem Gelenk schon entfernt
        arm.delete(arm.actuator("gripper"))
    grip.name = "wrist_roll_link"

    # Adapter (SO-ARM_Interface) auf dem Horn
    Rz = R.from_euler("z", a.mount_deg, degrees=True).as_matrix()
    T_g_a = np.eye(4)
    T_g_a[:3, :3] = Rz
    T_g_a[:3, 3] = HORN_CENTER_G - Rz @ HORN_CENTER_A
    arm.add_mesh(name="so_arm_interface", file="so_arm_interface.stl")
    pa, qa = pq(T_g_a)
    grip.add_geom(name="adapter_visual", type=mujoco.mjtGeom.mjGEOM_MESH,
                  meshname="so_arm_interface", pos=pa, quat=qa, contype=0, conaffinity=0,
                  group=2, rgba=[0.25, 0.25, 0.25, 1])
    grip.add_geom(name="adapter_col", type=mujoco.mjtGeom.mjGEOM_MESH,
                  meshname="so_arm_interface", pos=pa, quat=qa, group=3)
    am, acom, aI = mesh_mass_props(os.path.join(assets, "so_arm_interface.stl"), 1.0, T_g_a,
                                   density=PLA_DENSITY)
    grip.explicitinertial = True
    grip.mass, grip.ipos = am, acom
    grip.fullinertia = [aI[0, 0], aI[1, 1], aI[2, 2], aI[0, 1], aI[0, 2], aI[1, 2]]

    # Hand-Frame relativ zum Adapter:
    #  Adapter-STL (x,y,z) -> Wrist-Interface-STL (x,-z,y)   [über Bohrbild verifiziert]
    #  Wrist-Interface-STL -> Hand-Frame: Geom-Pose aus robot.xml
    wi = next(g for g in palm.geoms if g.meshname == "r_wrist_interface")
    R_wa = np.array([[1, 0, 0], [0, 0, -1], [0, 1, 0]], float)
    T_wa = np.eye(4)
    T_wa[:3, :3] = R_wa
    T_hand_a = T(wi.pos, wi.quat) @ T_wa
    T_g_hand = T_g_a @ np.linalg.inv(T_hand_a)
    ph, qh = pq(T_g_hand)
    frame = grip.add_frame(name="hand_mount", pos=ph, quat=qh)
    arm.attach(hand, frame=frame, prefix="hand_")

    # Gemeinsame Optionen
    arm.modelname = "so101_amazing_hand"
    arm.option.timestep = 0.002
    arm.option.integrator = mujoco.mjtIntegrator.mjINT_IMPLICITFAST
    arm.option.cone = mujoco.mjtCone.mjCONE_ELLIPTIC
    arm.option.impratio = 10
    arm.compiler.meshdir = "assets"

    model = arm.compile()
    # Keyframe "home": alle Gelenke in Nullstellung (Arm: Mitte des Bereichs, Hand: CAD-Pose)
    arm.add_key(name="home", qpos=model.qpos0, ctrl=np.zeros(model.nu))
    model = arm.compile()
    xml = arm.to_xml()
    with open(os.path.join(out, "so101_amazing_hand.xml"), "w") as fh:
        fh.write(xml)
    tpl = os.path.join(os.path.dirname(os.path.abspath(__file__)), "templates")
    for f in os.listdir(tpl):
        if not os.path.isfile(os.path.join(tpl, f)):
            continue
        txt = open(os.path.join(tpl, f)).read()
        if "{QPOS}" in txt:  # Greif-Szene: Startpose mit wrist_roll = -90°
            q = model.qpos0.copy()
            q[model.jnt_qposadr[model.joint("wrist_roll").id]] = -np.pi / 2
            c = np.zeros(model.nu)
            c[model.actuator("wrist_roll").id] = -np.pi / 2
            q = np.concatenate([q, [0.40, 0.046, 0.229, 1, 0, 0, 0]])  # Flasche (freejoint)
            txt = txt.replace("{QPOS}", " ".join(f"{v:.6g}" for v in q))
            txt = txt.replace("{CTRL}", " ".join(f"{v:.6g}" for v in c))
        with open(os.path.join(out, f), "w") as fh:
            fh.write(txt)
    os.makedirs(os.path.join(out, "tools"), exist_ok=True)
    shutil.copy(os.path.abspath(__file__), os.path.join(out, "tools", "build_model.py"))
    shutil.copytree(tpl, os.path.join(out, "tools", "templates"),
                    ignore=shutil.ignore_patterns("__pycache__"))
    os.remove(os.path.join(out, "_hand_src.xml"))
    os.remove(os.path.join(out, "_arm_src.xml"))
    print(f"OK: nq={model.nq} nv={model.nv} nu={model.nu} neq={model.neq} "
          f"Gesamtmasse={model.body_subtreemass[0]:.3f} kg")


if __name__ == "__main__":
    main()
