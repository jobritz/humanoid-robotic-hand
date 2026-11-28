"""
Umrechnung MediaPipe-Hand -> 8 Aktuator-Stellungen der Amazing Hand (Input des Gesten-Modells).

Identisch implementiert in browser-simulation/src/handMapping.js. Beide muessen gleich rechnen, sonst bekommt das
Gesten-Modell auf dem Raspberry Pi andere Werte als bei der Aufnahme der Trainingsdaten im Browser.
Pruefung: python test_hand_mapping.py (vergleicht mit hand_mapping_testdata.json, die auch der JS-Test nutzt).

Eingabe: die 21 "world landmarks" von MediaPipe (metrische 3D-Koordinaten in m, z. B. result.hand_world_landmarks[0]),
         als Objekte mit .x/.y/.z oder als Liste von [x, y, z].
Ausgabe: 8 Werte in rad, Reihenfolge wie ACTUATORS (gesture_common.py).

Vorgehen (Ansatz aus browser-simulation/src/mapping.js von Jonas Britz, Branch test-jonasb, auf rad umgestellt):
  1. Roh-Merkmale je Finger:
     - Beugung  = Summe der Knickwinkel entlang des Fingers (Grund-, Mittel-, Endgelenk; Daumen: 2 Gelenke)
     - Spreizung = Winkel des ersten Fingerglieds in der Handebene, gemessen gegen die Handrichtung
       (Handgelenk -> Mittelfinger-Grundgelenk) zur Daumenseite positiv
  2. Beugung linear auf 0..90 Grad abbilden: "open" = flache Hand, "fist" = Faust (Roh-Werte, siehe CALIBRATION)
  3. Spreizung = Roh-Wert minus Ruhelage, umso schwaecher, je staerker der Finger gebeugt ist (bei gebeugten Fingern
     ist die Messung unzuverlaessig, bei einer Faust ist die Spreizung 0), begrenzt auf +-35 Grad

Die Kalibrierung stammt aus 316 Aufnahmen echter Haende (Testdaten Roboterhand.csv, Zielposen nachgestellt):
5. bzw. 95. Perzentil der Beuge-Merkmale und Median der Spreizung bei gestreckten Fingern.
Mittlere Abweichung zur nachgestellten Zielpose dort: Beugung 15-19 Grad, Spreizung 16-18 Grad.
Die Merkmale haengen nicht davon ab, ob es eine linke oder rechte Hand ist.
"""

import math

FLEX_MAX = math.pi / 2          # 90 Grad (ctrlrange der *_flex-Aktuatoren in MuJoCo.xml)
ABD_MAX = math.radians(35)      # 35 Grad (ctrlrange der *_abd-Aktuatoren)

# Je Finger: Landmarken-Indizes und Kalibrierung (Roh-Werte in rad).
CALIBRATION = {
    "index":  {"open": 0.892, "fist": 2.540, "abd_neutral": -0.110},
    "middle": {"open": 0.707, "fist": 3.459, "abd_neutral": -0.169},
    "ring":   {"open": 0.599, "fist": 2.942, "abd_neutral": -0.320},
    "thumb":  {"open": 0.334, "fist": 1.977, "abd_neutral": 0.659},
}
FINGERS = [("index", [5, 6, 7, 8]), ("middle", [9, 10, 11, 12]), ("ring", [13, 14, 15, 16]), ("thumb", [1, 2, 3, 4])]


def _xyz(p):
    return (p.x, p.y, p.z) if hasattr(p, "x") else (float(p[0]), float(p[1]), float(p[2]))


def _sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _unit(a):
    n = math.sqrt(_dot(a, a)) or 1.0
    return (a[0] / n, a[1] / n, a[2] / n)


def _angle(a, b):
    return math.acos(min(1.0, max(-1.0, _dot(_unit(a), _unit(b)))))


def raw_features(landmarks):
    """21 Landmarken -> je Finger (Beugung, Spreizung) als Roh-Winkel in rad, Reihenfolge wie FINGERS."""
    lm = [_xyz(p) for p in landmarks]
    if len(lm) != 21:
        raise ValueError(f"Erwartet werden 21 Landmarken, erhalten: {len(lm)}")
    wrist = lm[0]
    fwd = _unit(_sub(lm[9], wrist))                       # Handrichtung
    s = _sub(lm[5], lm[17])                               # quer ueber die Hand, zur Daumenseite
    k = _dot(s, fwd)
    side = _unit((s[0] - k * fwd[0], s[1] - k * fwd[1], s[2] - k * fwd[2]))

    out = []
    for name, (a, b, c, d) in FINGERS:
        pa, pb, pc, pd = lm[a], lm[b], lm[c], lm[d]
        if name == "thumb":
            bend = _angle(_sub(pb, pa), _sub(pc, pb)) + _angle(_sub(pc, pb), _sub(pd, pc))
        else:
            bend = (_angle(_sub(pa, wrist), _sub(pb, pa)) + _angle(_sub(pb, pa), _sub(pc, pb))
                    + _angle(_sub(pc, pb), _sub(pd, pc)))
        v = _sub(pb, pa)
        out.append((bend, math.atan2(_dot(v, side), _dot(v, fwd))))
    return out


def landmarks_to_actuators(landmarks, calibration=CALIBRATION):
    """21 MediaPipe-world-landmarks -> 8 Aktuator-Stellungen in rad (Reihenfolge wie ACTUATORS)."""
    values = []
    for (name, _), (bend, spread) in zip(FINGERS, raw_features(landmarks)):
        cal = calibration[name]
        t = min(1.0, max(0.0, (bend - cal["open"]) / (cal["fist"] - cal["open"])))
        abd = (spread - cal["abd_neutral"]) * (1.0 - t)
        values += [t * FLEX_MAX, min(ABD_MAX, max(-ABD_MAX, abd))]
    return values


class Smoother:
    """Optional: glaettet aufeinanderfolgende Werte (exponentiell), gegen Zittern im Live-Betrieb.
    alpha = Anteil des neuen Werts (1 = keine Glaettung). Fuer Trainingsdaten nicht noetig."""

    def __init__(self, alpha=0.5):
        self.alpha = alpha
        self.values = None

    def __call__(self, values):
        if self.values is None:
            self.values = list(values)
        else:
            self.values = [v + self.alpha * (n - v) for v, n in zip(self.values, values)]
        return self.values
