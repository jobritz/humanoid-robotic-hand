# Platzhalter-Modell – nicht mit echten Daten trainiert

`gesture.tflite` in diesem Ordner wurde mit **künstlichen Daten** trainiert, nicht mit Aufnahmen echter Hände:
Gesten-Posen aus der Browser-Simulation (Stein, Schere, Papier wie `WINNING_POSES` in `browser-simulation/src/main.js`)
plus Zufallsrauschen, dazu zufällige Zwischenstellungen als „keine Geste“ (480 Datensätze).

Es dient nur dazu, die Kette (Modell laden, Aktuator-Stellungen auswerten, Geste anzeigen) zu zeigen und zu testen.
Gesten echter Hände erkennt es nur so gut, wie diese den Idealposen ähneln.

**Ersetzen:** Mit echten Aufnahmen neu trainieren (`python train_gesture_model.py --data aufnahme.csv`). Das überschreibt
`gesture.tflite`, `labels.txt` und `report.txt`. Danach **diese Datei löschen**, dann entfällt auch der Hinweis
„Platzhalter“ in der Browser-Simulation.
