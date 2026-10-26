import time
import numpy as np
import mujoco
import mujoco.viewer

m = mujoco.MjModel.from_xml_path('public/hand.xml')
d = mujoco.MjData(m)
print('nu =', m.nu,
      [mujoco.mj_id2name(m, mujoco.mjtObj.mjOBJ_ACTUATOR, i) for i in range(m.nu)])

with mujoco.viewer.launch_passive(m, d) as v:
    t0 = time.time()
    while v.is_running():
        t = time.time() - t0
        for i in range(0, m.nu, 2):
            d.ctrl[i] = 0.8 * (1 + np.sin(2 * t + 0.5 * i))   # Beugung 0..1.6
            d.ctrl[i + 1] = 0.3 * np.sin(1.3 * t)              # Abduktion
        mujoco.mj_step(m, d)
        v.sync()
        time.sleep(m.opt.timestep)